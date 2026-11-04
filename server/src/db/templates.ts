// Default wording. Every message the assistant sends comes from an *approved* template;
// these are the starting versions and can be edited (and re-approved) in the Templates screen.
// Placeholders: {{business}} {{ref}} {{medicine}} {{country}} {{privacyUrl}} {{consentText}}

export const SYSTEM_TEMPLATES = [
  {
    key: "bot.consent",
    name: "Assistant: welcome and consent",
    category: "system",
    body:
      "Hi, thanks for messaging {{business}}. I'm an automated assistant: I can take down your medicine inquiry so our pharmaceutical team can reply.\n\n" +
      "I'll ask for three things only: the medicine name, the country you need it in, and how you'd like us to contact you. " +
      "{{consentText}} Privacy notice: {{privacyUrl}}\n\n" +
      "Please don't send medical records, test results or prescriptions here. If this is a medical emergency, contact your local emergency services now.\n\n" +
      "Do you agree?",
  },
  { key: "bot.consent_reask", name: "Assistant: consent reminder", category: "system", body: "Please tap \"I agree\" to continue, or \"No thanks\" if you'd rather not. You can also reach us through our website." },
  {
    key: "bot.declined",
    name: "Assistant: consent declined",
    category: "system",
    body: "No problem, we won't keep your details. If you change your mind, just send us a message. Take care.",
  },
  { key: "bot.ask_medicine", name: "Assistant: ask medicine", category: "system", body: "Thank you. Which medicine are you asking about? The brand or generic name is fine." },
  { key: "bot.ask_country", name: "Assistant: ask country", category: "system", body: "Thanks. Which country would the medicine be needed in?" },
  { key: "bot.ask_contact", name: "Assistant: ask contact preference", category: "system", body: "How would you like our team to contact you?" },
  { key: "bot.ask_email", name: "Assistant: ask email", category: "system", body: "Please type the email address we should reply to." },
  { key: "bot.ask_phone", name: "Assistant: ask phone", category: "system", body: "Please type the phone number we should use, with the country code (for example +63 917 123 4567)." },
  { key: "bot.invalid_email", name: "Assistant: invalid email", category: "system", body: "That doesn't look like an email address. Could you check it and send it again?" },
  { key: "bot.invalid_phone", name: "Assistant: invalid phone", category: "system", body: "That doesn't look like a phone number. Please include the country code, for example +63 917 123 4567." },
  {
    key: "bot.handoff",
    name: "Assistant: inquiry received",
    category: "system",
    body: "Thank you. Your inquiry reference is {{ref}}. A member of our team will get back to you about {{medicine}} for {{country}}, usually within one business day.",
  },
  {
    key: "bot.handoff_review",
    name: "Assistant: inquiry received (pharmacist review)",
    category: "system",
    body:
      "Thank you. Your inquiry reference is {{ref}}. Because your question involves prescriptions, medical, regulatory or availability details, " +
      "a member of our pharmaceutical team will review it personally and reply. We can't give medical advice here, so please keep talking to your doctor.",
  },
  { key: "bot.ack", name: "Assistant: message received", category: "system", body: "Thanks, we've added this to your inquiry {{ref}}. Our team will reply here." },
  {
    key: "bot.optout",
    name: "Assistant: opted out",
    category: "system",
    body: "You won't receive any more messages from us. If you'd like your details deleted, reply DELETE. To start again later, just send us a message.",
  },
  { key: "bot.delete_ack", name: "Assistant: deletion request", category: "system", body: "We've received your request to delete your details. Our team will process it and confirm." },
  { key: "bot.human", name: "Assistant: person requested", category: "system", body: "Of course. I've asked a member of our team to take over this conversation. They'll reply here as soon as they can." },
];

export const AGENT_TEMPLATES = [
  {
    name: "Checking availability",
    category: "product_availability",
    body: "Thank you for your patience. We're checking availability of {{medicine}} for {{country}} with our suppliers and will update you on {{ref}} as soon as we hear back.",
  },
  {
    name: "Prescription needed",
    category: "prescription",
    body:
      "{{medicine}} is a prescription medicine. To proceed we'll need a valid prescription from your doctor. " +
      "Our pharmacist will explain how to send it securely. Please don't send it over Messenger.",
  },
  {
    name: "We can't give medical advice",
    category: "medical_question",
    body:
      "Thank you for asking. We're not able to give medical advice about doses, side effects or whether a treatment is right for you. " +
      "Please speak with your oncologist or doctor, who knows your situation. We're happy to help with supply and availability.",
  },
  {
    name: "Import requirements",
    category: "regulatory_import",
    body:
      "Importing {{medicine}} into {{country}} may need permits or documents from the local regulator. " +
      "Our team will confirm what's required and send you the details for {{ref}}.",
  },
  {
    name: "Quote follow-up",
    category: "pricing_quote",
    body: "Following up on {{ref}}: we've prepared the information you asked for about {{medicine}}. Would you like us to send it by your preferred contact method?",
  },
];
