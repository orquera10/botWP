import { handleReservationFlow } from './reservationFlow.js';

const invitationSteps = new Set([
  'birthday_invitation_offer',
  'birthday_invitation_name',
  'birthday_invitation_name_choice'
]);

// Payment notifications write their invitation state to the reservation flow.
// Process that state before Gemini, which otherwise cannot see the name prompt.
export async function handlePendingBirthdayInvitation(input) {
  if (!invitationSteps.has(input.state?.step)) return null;
  const output = await handleReservationFlow(input);
  if (output.state && !invitationSteps.has(output.state.step)) output.state = null;
  return output;
}
