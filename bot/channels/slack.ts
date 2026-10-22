import { slackChannel } from "@cursor/bdk/channels/slack";

/**
 * Socket Mode app for the demo Slack workspace. Tokens are not created here.
 * When that workspace is ready, run `bdk slack create` (see README). This
 * file matches the shape in the Slack guide so mentions and thread replies
 * resume one session per thread.
 */
export default slackChannel({
  envPrefix: "SPIKE_DETECTOR",
  suggestedPrompts: [
    {
      title: "Sign off",
      message: "signed off incident:<id>",
    },
  ],
});
