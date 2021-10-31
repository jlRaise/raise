import "source-map-support/register"
import createHttpError from "http-errors"
import { ulid } from "ulid"
import Stripe from "stripe"
import { middyfy } from "../../../../../helpers/wrapper"
import { get, insert } from "../../../../../helpers/db"
import { publicDonationRequest, publicPaymentIntentResponse } from "../../../../../helpers/schemas"
import { donationTable, fundraiserTable, paymentTable } from "../../../../../helpers/tables"
import env from "../../../../../env/env"
import { Fundraiser, PublicDonationRequest } from "../../../../../helpers/schemaTypes"

const stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: "2020-08-27", typescript: true })

export const main = middyfy(publicDonationRequest, publicPaymentIntentResponse, false, async (event) => {
  const now = Math.floor(new Date().getTime() / 1000)
  const fundraiser = await get(fundraiserTable, { id: event.pathParameters.fundraiserId })

  // Validate the fundraiser is within its active period
  if (fundraiser.activeFrom > now) {
    throw new createHttpError.BadRequest("This fundraiser has not started and is not taking donations yet")
  }
  if (fundraiser.activeTo < now) {
    throw new createHttpError.BadRequest("This fundraiser has ended and is no longer taking donations")
  }

  // Validate the fundraiser is not paused
  if (fundraiser.paused) {
    throw new createHttpError.BadRequest("This fundraiser has temporarily paused taking donations")
  }

  // Validate gift-aid requirements
  if (event.body.giftAid) {
    if (!event.body.addressLine1) throw new createHttpError.BadRequest("Gift-aided donation must provide address line 1")
    if (!event.body.addressPostcode) throw new createHttpError.BadRequest("Gift-aided donation must provide address postcode")
    if (!event.body.addressCountry) throw new createHttpError.BadRequest("Gift-aided donation must provide address country")
  }

  const paymentSchedule = calculatePaymentSchedule(event.body, fundraiser)

  // Validate payment amounts are greater than a global minimum (https://stripe.com/docs/currencies#minimum-and-maximum-charge-amounts)
  if (paymentSchedule.now.donationAmount + paymentSchedule.now.contributionAmount < 1_00) {
    throw new createHttpError.BadRequest("Donation amount must be greater than £1 to avoid excessive card transaction fees")
  }
  if (paymentSchedule.future.some((p) => p.donationAmount + p.contributionAmount < 1_00)) {
    throw new createHttpError.BadRequest("Future payments must be greater than £1 to avoid excessive card transaction fees")
  }

  // Validate donationAmount is greater than minimum, accounting for recurring donations
  if (fundraiser.minimumDonationAmount !== null) {
    const totalDonationAmount = paymentSchedule.now.donationAmount + paymentSchedule.future.reduce((acc, cur) => acc + cur.donationAmount, 0)
    if (totalDonationAmount < fundraiser.minimumDonationAmount) {
      throw new createHttpError.BadRequest(`Donation amount must be greater than £${(fundraiser.minimumDonationAmount / 100).toFixed(2)}`)
    }
  }

  const donationId = ulid()
  const paymentId = ulid()

  // Get stripe payment intent (attach metadata for fundraiserId, donationId, paymentId and contribution/donation amount)
  const paymentIntent = await stripe.paymentIntents.create({
    amount: paymentSchedule.now.donationAmount + paymentSchedule.now.contributionAmount,
    currency: "gbp",
    payment_method_types: ["card"],
    statement_descriptor_suffix: "Raise", // TODO: use fundraiser public name (or maybe have it dynamic, appearing like "RAISE* HELP 250 PEOPLE" or "RAISE* HELPING 250 PPL" etc.?)
    metadata: {
      fundraiserId: event.pathParameters.fundraiserId,
      donationId,
      paymentId,
    },
    setup_future_usage: event.body.recurrenceFrequency ? "off_session" : undefined,
  })
  const stripeClientSecret = paymentIntent.client_secret
  if (!stripeClientSecret) throw new Error("Failed to create Stripe client secret")

  // TODO: delete unpaid/failed donations after some timeout?
  // Insert the donation
  await insert(donationTable, {
    id: donationId,
    fundraiserId: event.pathParameters.fundraiserId,
    donorName: event.body.donorName,
    donorEmail: event.body.donorEmail,
    emailConsentInformational: event.body.emailConsentInformational,
    emailConsentMarketing: event.body.emailConsentMarketing,
    createdAt: now,
    addressLine1: event.body.addressLine1 || null,
    addressLine2: event.body.addressLine2 || null,
    addressLine3: event.body.addressLine3 || null,
    addressPostcode: event.body.addressPostcode || null,
    addressCountry: event.body.addressCountry || null,
    giftAid: event.body.giftAid,
    comment: event.body.comment || null,
    // The amounts are all zero, as at this point the donor hasn't given money
    // Once Stripe confirms their payment, we update all of these
    donationAmount: 0,
    matchFundingAmount: 0,
    contributionAmount: 0,
    recurringAmount: event.body.recurrenceFrequency ? event.body.donationAmount : null,
    recurrenceFrequency: event.body.recurrenceFrequency,
    // If this is a recurring donation, these will be filled in later once Stripe confirms the first payment. Otherwise, they will not be filled in
    stripeCustomerId: null,
    stripePaymentMethodId: null,
    // Donations to other charities should be manually added
    charity: "AMF",
    overallPublic: event.body.overallPublic,
    namePublic: event.body.namePublic,
    donationAmountPublic: event.body.donationAmountPublic,
  })

  // Can insert all the payments in parallel
  // If any fail, we abort and we just have a donation with some funky payments
  // We can't do it in parallel with the donation, as if the donation insert fails we may be left with orphaned payments
  await Promise.all([
    insert(paymentTable, {
      id: paymentId,
      donationId,
      fundraiserId: event.pathParameters.fundraiserId,
      at: now,
      donationAmount: paymentSchedule.now.donationAmount,
      contributionAmount: paymentSchedule.now.contributionAmount,
      matchFundingAmount: null,
      method: "card",
      reference: paymentIntent.id,
      status: "pending",
    }),
    ...paymentSchedule.future.map((p) => (insert(paymentTable, {
      id: ulid(),
      donationId,
      fundraiserId: event.pathParameters.fundraiserId,
      at: p.at,
      donationAmount: p.donationAmount,
      contributionAmount: p.contributionAmount,
      matchFundingAmount: null,
      method: "card",
      reference: null,
      status: "pending",
    }))),
  ])

  return {
    stripeClientSecret,
    amount: paymentSchedule.now.donationAmount + paymentSchedule.now.contributionAmount,
    futurePayments: paymentSchedule.future.map((p) => ({ at: p.at, amount: p.donationAmount + p.contributionAmount })),
  }
})

const addRecurrencePeriod = (date: Date, frequency: "WEEKLY" | "MONTHLY") => {
  if (frequency === "WEEKLY") {
    date.setDate(date.getDate() + 7)
  } else if (frequency === "MONTHLY") {
    date.setMonth(date.getMonth() + 1)
  }
}

const calculatePaymentSchedule = (request: PublicDonationRequest, fundraiser: Fundraiser): { now: { donationAmount: number, contributionAmount: number }, future: { at: number, donationAmount: number, contributionAmount: number }[] } => {
  const future: { at: number, donationAmount: number, contributionAmount: number }[] = []

  // For recurring donations, insert future payments
  if (request.recurrenceFrequency) {
    const date = new Date()
    date.setHours(0, 0, 0, 0)
    addRecurrencePeriod(date, request.recurrenceFrequency)
    while (Math.floor(date.getTime() / 1000) < fundraiser.activeTo) {
      future.push({ at: Math.floor(date.getTime() / 1000), donationAmount: request.donationAmount, contributionAmount: 0 })
      addRecurrencePeriod(date, request.recurrenceFrequency)
    }
  }

  return {
    now: { donationAmount: request.donationAmount, contributionAmount: request.contributionAmount },
    future,
  }
}
