import { defaultOnAppMention, slackChannel } from "@cursor/bdk/channels/slack";

/** Reactions on the bot's page that count as sign-off. */
const SIGNOFF_REACTIONS = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark", "shipit"]);

/**
 * Socket Mode app for the demo Slack workspace. Tokens come from
 * `bdk slack create`. Mentions and thread replies resume one session per
 * thread. A thumbs-up on the page resumes that thread as a sign-off.
 */
export default slackChannel({
  envPrefix: "SPIKE_DETECTOR",
  suggestedPrompts: [
    {
      title: "Sign off",
      message: "signed off incident:<id>",
    },
  ],
  onReactionAdded: async (ctx, message) => {
    const name = message.reaction?.name?.split("::")[0];
    if (!name || !SIGNOFF_REACTIONS.has(name)) return null;
    const decision = await defaultOnAppMention(ctx, message);
    if (!decision) return decision;
    return {
      ...decision,
      message: `signed off (reacted :${name}: on the page). Load the incident:<id> from this thread and record the sign-off.`,
    };
  },
});
