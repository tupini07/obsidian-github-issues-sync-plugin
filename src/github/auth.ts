/**
 * GitHub OAuth Device Flow authentication
 */

import { requestUrl } from "obsidian";
import type {
  AuthState,
  DeviceCodeResponse,
  TokenResponse,
} from "../types";

/** Required OAuth scopes */
const OAUTH_SCOPES = "repo read:project";

/** Polling interval for device flow (in ms) */
const POLL_INTERVAL_MS = 5000;

/**
 * Get the GitHub API base URL
 */
export function getGitHubApiUrl(githubBaseUrl: string): string {
  if (!githubBaseUrl || githubBaseUrl === "github.com") {
    return "https://api.github.com";
  }
  // GitHub Enterprise uses /api/v3 path
  return `https://${githubBaseUrl}/api/v3`;
}

/**
 * Get the GitHub base URL for OAuth endpoints
 */
export function getGitHubBaseUrl(githubBaseUrl: string): string {
  if (!githubBaseUrl || githubBaseUrl === "github.com") {
    return "https://github.com";
  }
  return `https://${githubBaseUrl}`;
}

/**
 * Request a device code to start the OAuth flow
 */
export async function requestDeviceCode(
  clientId: string,
  githubBaseUrl: string
): Promise<DeviceCodeResponse> {
  const baseUrl = getGitHubBaseUrl(githubBaseUrl);
  const url = `${baseUrl}/login/device/code`;

  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      scope: OAUTH_SCOPES,
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Failed to request device code: ${response.status}`);
  }

  return response.json as DeviceCodeResponse;
}

/**
 * Poll for access token after user has authorized
 */
export async function pollForToken(
  clientId: string,
  deviceCode: string,
  githubBaseUrl: string,
  interval: number
): Promise<TokenResponse | null> {
  const baseUrl = getGitHubBaseUrl(githubBaseUrl);
  const url = `${baseUrl}/login/oauth/access_token`;

  const response = await requestUrl({
    url,
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });

  if (response.status !== 200) {
    throw new Error(`Token request failed: ${response.status}`);
  }

  const data = response.json;

  // Check for errors in response
  if (data.error) {
    switch (data.error) {
      case "authorization_pending":
        // User hasn't authorized yet, keep polling
        return null;
      case "slow_down":
        // We're polling too fast, will be handled by caller
        return null;
      case "expired_token":
        throw new Error("Device code expired. Please try again.");
      case "access_denied":
        throw new Error("Authorization was denied by the user.");
      default:
        throw new Error(`OAuth error: ${data.error_description || data.error}`);
    }
  }

  return data as TokenResponse;
}

/**
 * Get the authenticated user's info
 */
export async function getAuthenticatedUser(
  accessToken: string,
  githubBaseUrl: string
): Promise<{ login: string }> {
  const apiUrl = getGitHubApiUrl(githubBaseUrl);

  const response = await requestUrl({
    url: `${apiUrl}/user`,
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status !== 200) {
    throw new Error(`Failed to get user info: ${response.status}`);
  }

  return response.json;
}

/**
 * Perform the complete device flow authentication
 * Returns the auth state if successful, null if cancelled
 */
export async function performDeviceFlow(
  clientId: string,
  githubBaseUrl: string,
  onUserCode: (userCode: string, verificationUri: string) => void
): Promise<AuthState | null> {
  // Step 1: Request device code
  const deviceCodeResponse = await requestDeviceCode(clientId, githubBaseUrl);

  const { device_code, user_code, verification_uri, expires_in, interval } =
    deviceCodeResponse;

  // Step 2: Show user the code and open browser
  onUserCode(user_code, verification_uri);

  // Open the verification URL in browser
  window.open(verification_uri, "_blank");

  // Step 3: Poll for token
  const pollIntervalMs = Math.max(interval * 1000, POLL_INTERVAL_MS);
  const expiresAt = Date.now() + expires_in * 1000;

  while (Date.now() < expiresAt) {
    await sleep(pollIntervalMs);

    try {
      const tokenResponse = await pollForToken(
        clientId,
        device_code,
        githubBaseUrl,
        interval
      );

      if (tokenResponse) {
        // Success! Get user info
        const userInfo = await getAuthenticatedUser(
          tokenResponse.access_token,
          githubBaseUrl
        );

        const authState: AuthState = {
          accessToken: tokenResponse.access_token,
          refreshToken: tokenResponse.refresh_token || null,
          expiresAt: tokenResponse.expires_in
            ? new Date(
                Date.now() + tokenResponse.expires_in * 1000
              ).toISOString()
            : null,
          username: userInfo.login,
        };

        return authState;
      }
    } catch (error) {
      // Re-throw non-polling errors
      if (
        error instanceof Error &&
        !error.message.includes("authorization_pending")
      ) {
        throw error;
      }
    }
  }

  throw new Error("Device code expired. Please try again.");
}

/**
 * Sleep for a given number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
