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
let joinState = { joined: false, joinerInboxId: null, error: null };

/**
 * Get the current join state
 * @returns {{joined: boolean, joinerInboxId: string|null, error: string|null}}
 */
export function getJoinState() {
  return { ...joinState };
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
  }
}

/**
 * Setup Convos channel - creates conversation and returns invite URL
 * Keeps agent running to accept join requests
 * @param {object} options
 * @param {string} [options.env] - XMTP environment (production/dev)
 * @param {string} [options.name] - Optional conversation name
 * @returns {Promise<{inviteUrl: string, conversationId: string, privateKey: string}>}
 */
export async function setupConvos(options = {}) {
  // Stop any existing agent first
  await stopConvosAgent();

  // Reset join state
  joinState = { joined: false, joinerInboxId: null, error: null };

  const env = options.env || "production";
  const conversationName = options.name || "OpenClaw";

  console.log(`[convos-setup] Creating XMTP identity (env: ${env})...`);

  // Create new user (generates private key)
  const user = createUser();
  const signer = createSigner(user);

  // Create XMTP agent
  const agent = await Agent.create(signer, { env });

  // Create Convos middleware
  const convos = ConvosMiddleware.create(agent, { privateKey: user.key });
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
  console.log("[convos-setup] Agent kept running to accept join requests");

  // Save config via openclaw CLI
  const configJson = JSON.stringify({
    enabled: true,
    privateKey: user.key,
    env,
    ownerConversationId: group.id,
  });

  try {
    execSync(`openclaw config set --json channels.convos '${configJson}'`, {
      stdio: "inherit",
    });
    console.log("[convos-setup] Config saved successfully");

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
