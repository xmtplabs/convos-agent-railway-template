/**
 * Convos setup script for Railway template
 * Creates a conversation and returns invite URL for QR code display
 */

import { Agent, createUser, createSigner } from "@xmtp/agent-sdk";
import { ConvosMiddleware } from "convos-node-sdk";
import { execSync } from "child_process";

// Note: invite.url from SDK is already fully formed, no need for base URL

/**
 * Setup Convos channel - creates conversation and returns invite URL
 * @param {object} options
 * @param {string} [options.env] - XMTP environment (production/dev)
 * @param {string} [options.name] - Optional conversation name
 * @returns {Promise<{inviteUrl: string, conversationId: string, privateKey: string}>}
 */
export async function setupConvos(options = {}) {
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

  // Stop the agent
  await agent.stop();

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
