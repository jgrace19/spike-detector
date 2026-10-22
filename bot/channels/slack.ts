import type { HostContext } from "@cursor/bdk";
import { defaultOnAppMention, slackChannel } from "@cursor/bdk/channels/slack";
import { postSlack } from "../lib/notify.js";
import { handleShipReaction } from "../lib/ship.js";
import { SHIP_FAILED_TEXT } from "../lib/slack-cards.js";
import {
  handleApproveButton,
  handleSignoffReaction,
  handleSignoffReply,
  incidentForSlackTs,
} from "../lib/slack-signoff.js";

type ReactionMessage = {
  text?: string;
  body?: string;
  markdown?: string;
  ts?: string;
  threadTs: string;
  channelId: string;
  reaction?: { name: string };
  author?: { userId: string; userName?: string };
};

/**
 * Socket Mode app. Tokens come from `bdk slack create`. A thumbs-up or
 * approve reply on the triage message records sign-off in the handler and
 * does not start a model turn, so one reaction cannot produce two replies.
 * Reactions on the alert are ignored. A rocket reaction is handled only on
 * the ship-review message. It records the ship and does not merge or start
 * a model turn. A failed ship posts a short note in the thread. Thread
 * replies are watched so "approve" counts without an @mention when the host
 * delivers them.
 */
export async function handleSlackReaction(host: HostContext, message: ReactionMessage): Promise<void> {
  try {
    const outcome = await handleShipReaction(host, message);
    if (outcome.status === "failed") {
      console.warn(`[spike-detector] ship failed: ${outcome.reason}`);
      await postShipFailureNote(host, message);
    }
  } catch (error) {
    console.warn(
      `[spike-detector] ship failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    await postShipFailureNote(host, message);
  }
  await handleSignoffReaction(host, {
    text: message.text ?? "",
    body: message.body ?? "",
    markdown: message.markdown ?? "",
    ts: message.ts ?? message.threadTs,
    threadTs: message.threadTs,
    channelId: message.channelId,
    ...(message.reaction === undefined ? {} : { reaction: message.reaction }),
    ...(message.author === undefined ? {} : { author: message.author }),
  });
}

async function postShipFailureNote(host: HostContext, message: ReactionMessage): Promise<void> {
  try {
    const incident = await incidentForSlackTs(host, message.threadTs, message.channelId);
    if (incident?.slackThreadTs === undefined) {
      return;
    }
    const posted = await postSlack({
      host,
      incident,
      text: SHIP_FAILED_TEXT,
      thread: true,
    });
    if (!posted.posted) {
      console.warn(`[spike-detector] ship failure note failed: ${posted.reason}`);
    }
  } catch (error) {
    console.warn(
      `[spike-detector] ship failure note failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

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
    await handleSlackReaction(ctx.host, message);
    return null;
  },
  onBlockAction: async (ctx, action) => {
    await handleApproveButton(ctx.host, action);
    return null;
  },
});
