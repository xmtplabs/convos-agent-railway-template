/**
 * Convos setup script for Railway template
 * Creates a conversation and returns invite URL for QR code display
 * Keeps agent running to handle join requests
 */

import { Agent, createUser, createSigner } from "@xmtp/agent-sdk";
import { ConvosMiddleware } from "convos-node-sdk";
import { execSync } from "child_process";

// Note: invite.url from SDK is already fully formed, no need for base URL

// Module-level state for persistent agent
let activeAgent = null;
let activeConvos = null;
let activeGroup = null;
let joinState = { joined: false, joinerInboxId: null, error: null };

/**
 * Get the current join state
 * @returns {{joined: boolean, joinerInboxId: string|null, error: string|null}}
 */
export function getJoinState() {
  return { ...joinState };
}

/**
 * Get the active group (if setup is in progress)
 * @returns {object|null}
 */
export function getActiveGroup() {
  return activeGroup;
}

/**
 * Send a message to the active Convos conversation
 * @param {string} message - The message to send
 */
export async function sendMessage(message) {
  if (!activeGroup) {
    throw new Error("No active group - setup not complete");
  }
  // Sync the group to ensure new members can receive messages
  console.log("[convos-setup] Syncing group before sending...");
  await activeGroup.sync();
  console.log("[convos-setup] Sending message...");
  await activeGroup.send(message);
  console.log("[convos-setup] Message sent to conversation");
}

/**
 * Stop the active Convos agent (cleanup after join or timeout)
 */
export async function stopConvosAgent() {
  if (activeAgent) {
    try {
      await activeAgent.stop();
      console.log("[convos-setup] Agent stopped");
    } catch (err) {
      console.error("[convos-setup] Error stopping agent:", err.message);
    }
    activeAgent = null;
    activeConvos = null;
    activeGroup = null;
  }
}

/**
 * Setup Convos channel - creates conversation and returns invite URL
 * Keeps agent running to accept join requests
 * @param {object} options
 * @param {string} [options.env] - XMTP environment (production/dev), defaults to XMTP_ENV env var or "production"
 * @returns {Promise<{inviteUrl: string, conversationId: string, privateKey: string}>}
 */
export async function setupConvos(options = {}) {
  // Stop any existing agent first
  await stopConvosAgent();

  // Reset join state
  joinState = { joined: false, joinerInboxId: null, error: null };

  // Use XMTP_ENV environment variable, defaulting to production
  const env = options.env || process.env.XMTP_ENV || "production";
  const conversationName = "OpenClaw";

  console.log(`[convos-setup] Creating XMTP identity (env: ${env})...`);

  // Create new user (generates private key)
  const user = createUser();
  const signer = createSigner(user);

  // Create XMTP agent
  const agent = await Agent.create(signer, { env });

  // Create Convos middleware (pass env so it generates correct invite URL)
  const convos = ConvosMiddleware.create(agent, { privateKey: user.key, env });
  agent.use(convos.middleware());

  // Set up invite handler to auto-accept join requests
  convos.on("invite", async (ctx) => {
    console.log(`[convos-setup] Join request from ${ctx.joinerInboxId}`);
    try {
      await ctx.accept();
      joinState = { joined: true, joinerInboxId: ctx.joinerInboxId, error: null };
      console.log(`[convos-setup] Accepted join from ${ctx.joinerInboxId}`);
    } catch (err) {
      joinState.error = err.message;
      console.error(`[convos-setup] Failed to accept join:`, err);
    }
  });

  console.log("[convos-setup] Creating conversation...");

  // Start agent to enable conversation creation
  await agent.start();

  // Create XMTP group and wrap with Convos
  const group = await agent.client.conversations.createGroup([]);
  const convosGroup = convos.group(group);
  const invite = await convosGroup.createInvite({ name: conversationName });

  console.log(`[convos-setup] Conversation created: ${group.id}`);

  // Get invite URL (already fully formed from SDK)
  const inviteUrl = invite.url;

  console.log(`[convos-setup] Invite URL: ${inviteUrl}`);

  // Keep agent running to handle join requests
  activeAgent = agent;
  activeConvos = convos;
  activeGroup = group;
  console.log("[convos-setup] Agent kept running to accept join requests");

  // Save config via openclaw CLI
  // Use dmPolicy: "open" with allowFrom: ["*"] since access is controlled by the invite link
  const configJson = JSON.stringify({
    enabled: true,
    privateKey: user.key,
    env,
    ownerConversationId: group.id,
    dmPolicy: "open",
    allowFrom: ["*"],
  });

  try {
    execSync(`openclaw config set --json channels.convos '${configJson}'`, {
      stdio: "inherit",
    });
    console.log("[convos-setup] Config saved successfully");

    // Ensure gateway.mode is set so gateway can start
    execSync(`openclaw config set gateway.mode local`, {
      stdio: "inherit",
    });
    console.log("[convos-setup] Gateway mode set to local");

    // Run doctor --fix to fully enable the channel
    execSync(`openclaw doctor --fix`, {
      stdio: "inherit",
    });
    console.log("[convos-setup] Doctor --fix completed");
  } catch (err) {
    console.error("[convos-setup] Failed to save config:", err.message);
    throw err;
  }

  return {
    inviteUrl,
    inviteSlug: invite.slug,
    conversationId: group.id,
    privateKey: user.key,
  };
}

// CLI entry point
if (process.argv[1] === import.meta.filename) {
  const env = process.argv.includes("--dev") ? "dev" : "production";
  const nameIdx = process.argv.indexOf("--name");
  const name = nameIdx >= 0 ? process.argv[nameIdx + 1] : undefined;

  setupConvos({ env, name })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("Setup failed:", err);
      process.exit(1);
    });
}
