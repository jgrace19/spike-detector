import { defaultOnAppMention, slackChannel } from "@cursor/bdk/channels/slack";
import { handleApproveButton, handleSignoffReaction, handleSignoffReply } from "../lib/slack-signoff.js";

/**
 * Socket Mode app for the demo Slack workspace. Tokens come from
 * `bdk slack create`. A thumbs-up or approve reply on the triage message
 * records sign-off in the handler and does not start a model turn, so one
 * reaction cannot produce two replies. Reactions on the alert are ignored.
 * Thread replies are watched so "approve" counts without an @mention when
 * the host delivers them.
 */
export default slackChannel({
  envPrefix: "SPIKE_DETECTOR",
  suggestedPrompts: [
    {
      title: "Approve fix",
      message: "approve",
    },
  ],
  engagement: {
    channelPosts: {
      allow: ["*"],
      posts: "replies",
      replies: "joined",
    },
  },
  onAppMention: async (ctx, message) => {
    if ((await handleSignoffReply(ctx.host, message)) === "handled") {
      return null;
    }
    return defaultOnAppMention(ctx, message);
  },
  onChannelPost: async (ctx, message) => {
    if ((await handleSignoffReply(ctx.host, message)) === "handled") {
      return null;
    }
    return null;
  },
  onReactionAdded: async (ctx, message) => {
    await handleSignoffReaction(ctx.host, message);
    return null;
  },
  onBlockAction: async (ctx, action) => {
    await handleApproveButton(ctx.host, action);
    return null;
  },
});
