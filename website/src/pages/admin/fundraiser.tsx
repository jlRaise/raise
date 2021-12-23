import * as React from "react"
import { navigate, RouteComponentProps } from "@reach/router"

import {
  DownloadIcon, EyeIcon, EyeOffIcon, PlusSmIcon,
} from "@heroicons/react/outline"
import jsonexport from "jsonexport/dist"
import { asResponseValues, useAxios, useRawAxios } from "../../helpers/networking"
import Section, { SectionTitle } from "../../components/Section"
import { Fundraiser, Donation, DonationEdits } from "../../helpers/schemaTypes"
import Table from "../../components/Table"
import PropertyEditor from "../../components/PropertyEditor"
import Modal from "../../components/Modal"
import { Form } from "../../components/Form"
import Button from "../../components/Button"
import {
  amountFormatter, booleanFormatter, matchFundingRateFormatter, timestampFormatter,
} from "../../helpers/format"
import { RequireGroup } from "../../helpers/security"

const FundraiserPage: React.FC<RouteComponentProps & { fundraiserId?: string }> = ({ fundraiserId }) => {
  const [fundraisers, refetchFundraisers] = useAxios<Fundraiser[]>("/admin/fundraisers")
  const fundraiser = asResponseValues(fundraisers.data?.find((f) => f.id === fundraiserId), fundraisers)
  const axios = useRawAxios()

  return (
    <Section>
      <SectionTitle>{fundraiser.data?.fundraiserName || "Fundraiser"}</SectionTitle>
      <PropertyEditor
        definition={{
          fundraiserName: { label: "Name", inputType: "text" },
          activeFrom: { label: "From", formatter: timestampFormatter, inputType: "datetime-local" },
          activeTo: { label: "To", formatter: timestampFormatter, inputType: "datetime-local" },
          recurringDonationsTo: { label: "Recurring donations to", formatter: timestampFormatter, inputType: "datetime-local" },
          paused: { label: "Paused", formatter: booleanFormatter, inputType: "checkbox" },
          goal: { label: "Goal", formatter: amountFormatter, inputType: "amount" },
          totalRaised: {
            label: "Total", formatter: amountFormatter, inputType: "amount", warning: "Do not edit the total unless you know what you are doing. You probably want to add a manual donation instead.",
          },
          donationsCount: {
            label: "Donation count", inputType: "number", warning: "Do not edit the donation count unless you know what you are doing. You probably want to add a manual donation instead.",
          },
          matchFundingRate: { label: "Match funding rate", formatter: matchFundingRateFormatter, inputType: "number" },
          matchFundingPerDonationLimit: { label: "Match funding per donation limit", formatter: amountFormatter, inputType: "amount" },
          matchFundingRemaining: {
            label: "Match funding remaining", formatter: amountFormatter, inputType: "amount", warning: "Do not edit the match funding remaining unless you know what you are doing.",
          },
          minimumDonationAmount: { label: "Minimum donation amount", formatter: amountFormatter, inputType: "amount" },
          suggestedDonationAmountOneOff: { label: "Suggested one off donation amount", formatter: amountFormatter, inputType: "amount" },
          suggestedDonationAmountWeekly: { label: "Suggested weekly donation amount", formatter: amountFormatter, inputType: "amount" },
          suggestedContributionAmount: { label: "Suggested contribution amount", formatter: amountFormatter, inputType: "amount" },
          groupsWithAccess: {
            label: "Groups with access", formatter: (groups: string[]) => groups.join(", ") || "(none selected)", inputType: "multiselect", selectOptions: ["National", "Demo"],
          },
        }}
        item={fundraiser}
        onSave={async (data) => {
          await axios.patch(`/admin/fundraisers/${fundraiserId}`, {
            ...data,
            previous: {
              totalRaised: fundraiser.data?.totalRaised,
              donationsCount: fundraiser.data?.donationsCount,
            },
          })
          refetchFundraisers()
        }}
      />

      <RequireGroup group={fundraiser.data?.groupsWithAccess}>
        <DonationsSummaryView fundraiserId={fundraiserId} />
      </RequireGroup>
    </Section>
  )
}

const DonationsSummaryView: React.FC<{ fundraiserId?: string }> = ({ fundraiserId }) => {
  const [donations, refetchDonations] = useAxios<Donation[]>(`/admin/fundraisers/${fundraiserId}/donations`)
  const [newDonationModalOpen, setNewDonationModalOpen] = React.useState(false)
  const [showUncounted, setShowUncounted] = React.useState(false)
  const axios = useRawAxios()

  const downloadDonationsCSV = async () => {
    const csv = donations.data && await jsonexport(donations.data)
    if (csv) {
      const encodedUri = encodeURI(`data:text/csv;charset=utf-8,${csv}`)
      const link = document.createElement("a")
      link.setAttribute("href", encodedUri)
      link.setAttribute("download", `${fundraiserId}-donations.csv`)
      document.body.appendChild(link)
      link.click()
    }
  }

  return (
    <>
      <div className="flex mt-12">
        <SectionTitle className="flex-1">Donations</SectionTitle>
        {!showUncounted && <Button onClick={() => setShowUncounted(true)}><EyeIcon className="h-6 mb-1" /> Show uncounted</Button>}
        {showUncounted && <Button onClick={() => setShowUncounted(false)}><EyeOffIcon className="h-6 mb-1" /> Hide uncounted</Button>}
        <Button onClick={() => downloadDonationsCSV()}><DownloadIcon className="h-6 mb-1" /> CSV</Button>
        <Button onClick={() => setNewDonationModalOpen(true)}><PlusSmIcon className="h-6 mb-1" /> New manual donation</Button>
      </div>
      <Modal open={newDonationModalOpen} onClose={() => setNewDonationModalOpen(false)}>
        <Form<DonationEdits>
          title="New donation"
          definition={{
            donorName: { label: "Donor name", inputType: "text" },
            donorEmail: { label: "Donor email", inputType: "email" },
            emailConsentInformational: { label: "Email consent: informational", formatter: booleanFormatter, inputType: "checkbox" },
            emailConsentMarketing: { label: "Email consent: marketing", formatter: booleanFormatter, inputType: "checkbox" },
            addressLine1: { label: "Address line 1", inputType: "text" },
            addressLine2: { label: "Address line 2", inputType: "text" },
            addressLine3: { label: "Address line 3", inputType: "text" },
            addressPostcode: { label: "Address postcode", inputType: "text" },
            addressCountry: { label: "Address country", inputType: "text" },
            giftAid: {
              label: "Gift-aided", formatter: booleanFormatter, inputType: "checkbox", warning: "We must hold accurate names and addresses for gift-aided donations as per the Income Tax Act 2007",
            },
            charity: { label: "Designated charity", inputType: "text" },
            comment: { label: "Donor comment", inputType: "text" },
            overallPublic: { label: "Donation is public", formatter: booleanFormatter, inputType: "checkbox" },
            namePublic: { label: "Donor name is public", formatter: booleanFormatter, inputType: "checkbox" },
            donationAmountPublic: { label: "Donation amount is public", formatter: booleanFormatter, inputType: "checkbox" },
          }}
          initialValues={{
            donorName: "",
            donorEmail: "",
            emailConsentInformational: false,
            emailConsentMarketing: false,
            addressLine1: null,
            addressLine2: null,
            addressLine3: null,
            addressPostcode: null,
            addressCountry: null,
            giftAid: false,
            comment: null,
            charity: "AMF",
            overallPublic: false,
            namePublic: false,
            donationAmountPublic: false,
          }}
          showCurrent={false}
          onSubmit={async (data) => {
            const donationId = (await axios.post<string>(`/admin/fundraisers/${fundraiserId}/donations`, data)).data
            await refetchDonations()
            navigate(`/admin/${fundraiserId}/${donationId}`)
          }}
        />
      </Modal>
      <Table
        definition={{
          donorName: { label: "Name" },
          donorEmail: { label: "Email" },
          createdAt: { label: "At", formatter: timestampFormatter },
          donationAmount: { label: "Donated", formatter: amountFormatter },
          matchFundingAmount: { label: "Matched", formatter: amountFormatter },
        }}
        items={showUncounted ? donations : asResponseValues(donations.data?.filter((d) => d.donationCounted), donations)}
        onClick={(donation) => navigate(`/admin/${fundraiserId}/${donation.id}/`)}
      />
    </>
  )
}

export default FundraiserPage
