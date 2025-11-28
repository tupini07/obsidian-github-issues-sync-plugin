/**
 * GitHub GraphQL API client
 */

import { requestUrl } from "obsidian";
import { getGitHubApiUrl } from "./auth";
import {
  GET_PROJECT_METADATA,
  GET_PROJECT_ITEMS,
  UPDATE_ISSUE,
  GET_ISSUE,
} from "./queries";
import type {
  ProjectInfo,
  ProjectMetadata,
  GitHubIssue,
  StatusOption,
  Iteration,
} from "../types";

/**
 * Parse a GitHub Project URL into its components
 * Supports: https://github.com/orgs/{org}/projects/{number}
 */
export function parseProjectUrl(url: string): ProjectInfo | null {
  // Match: https://github.com/orgs/{org}/projects/{number}
  // or: https://{enterprise}/orgs/{org}/projects/{number}
  const orgMatch = url.match(/\/orgs\/([^\/]+)\/projects\/(\d+)/);
  if (orgMatch) {
    return {
      ownerType: "orgs",
      owner: orgMatch[1],
      projectNumber: parseInt(orgMatch[2], 10),
    };
  }

  // Match: https://github.com/users/{user}/projects/{number}
  const userMatch = url.match(/\/users\/([^\/]+)\/projects\/(\d+)/);
  if (userMatch) {
    return {
      ownerType: "users",
      owner: userMatch[1],
      projectNumber: parseInt(userMatch[2], 10),
    };
  }

  return null;
}

/** Retry configuration */
const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

/** Status codes that should trigger a retry */
const RETRYABLE_STATUS_CODES = [502, 503, 504, 429];

/**
 * Sleep for a specified duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a GraphQL query against the GitHub API with retry logic
 */
export async function graphqlRequest<T>(
  accessToken: string,
  githubBaseUrl: string,
  query: string,
  variables: Record<string, unknown> = {}
): Promise<T> {
  const apiUrl = getGitHubApiUrl(githubBaseUrl);
  const graphqlUrl = apiUrl.includes("api.github.com")
    ? "https://api.github.com/graphql"
    : `${apiUrl}/graphql`;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await requestUrl({
        url: graphqlUrl,
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query,
          variables,
        }),
      });

      if (response.status === 200) {
        const data = response.json;

        if (data.errors && data.errors.length > 0) {
          const errorMessages = data.errors
            .map((e: { message: string }) => e.message)
            .join(", ");
          throw new Error(`GraphQL errors: ${errorMessages}`);
        }

        return data.data as T;
      }

      // Check if we should retry this status code
      if (RETRYABLE_STATUS_CODES.includes(response.status)) {
        lastError = new Error(`Request failed, status ${response.status}`);
        console.log(
          `GitHub API returned ${response.status}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`
        );
      } else {
        // Non-retryable error, throw immediately
        throw new Error(`GraphQL request failed: ${response.status}`);
      }
    } catch (error) {
      // Check if this is a retryable error (network issues, timeouts)
      if (error instanceof Error) {
        const isRetryable =
          error.message.includes("status 502") ||
          error.message.includes("status 503") ||
          error.message.includes("status 504") ||
          error.message.includes("status 429") ||
          error.message.includes("timeout") ||
          error.message.includes("network");

        if (isRetryable && attempt < MAX_RETRIES - 1) {
          lastError = error;
          console.log(
            `Request failed: ${error.message}, retrying (attempt ${attempt + 1}/${MAX_RETRIES})...`
          );
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    // Wait before retrying with exponential backoff
    if (attempt < MAX_RETRIES - 1) {
      const delay = INITIAL_DELAY_MS * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  // All retries exhausted
  throw lastError || new Error("Request failed after retries");
}

/**
 * Fetch project metadata (fields, status options, iterations)
 */
export async function fetchProjectMetadata(
  accessToken: string,
  githubBaseUrl: string,
  projectInfo: ProjectInfo
): Promise<ProjectMetadata> {
  interface ProjectMetadataResponse {
    organization?: {
      projectV2: {
        id: string;
        title: string;
        fields: {
          nodes: Array<{
            id?: string;
            name?: string;
            options?: Array<{ id: string; name: string; color?: string }>;
            configuration?: {
              iterations: Array<{
                id: string;
                title: string;
                startDate: string;
                duration: number;
              }>;
            };
          }>;
        };
      } | null;
    } | null;
  }

  const data = await graphqlRequest<ProjectMetadataResponse>(
    accessToken,
    githubBaseUrl,
    GET_PROJECT_METADATA,
    {
      owner: projectInfo.owner,
      projectNumber: projectInfo.projectNumber,
    }
  );

  // Check if we got the expected data
  if (!data.organization) {
    throw new Error(
      `Could not find organization "${projectInfo.owner}". Make sure the GitHub App has access to this organization.`
    );
  }

  if (!data.organization.projectV2) {
    throw new Error(
      `Could not find project #${projectInfo.projectNumber} in organization "${projectInfo.owner}". Make sure the project exists and the GitHub App has the "Projects" read permission.`
    );
  }

  const project = data.organization.projectV2;

  if (!project.fields) {
    throw new Error(
      `Could not read project fields. Make sure the GitHub App has "Projects" read permission.`
    );
  }

  // Find the Status field (single select)
  let statusField: { id: string; options: StatusOption[] } | null = null;
  let iterationField: { id: string; iterations: Iteration[] } | null = null;

  for (const field of project.fields.nodes) {
    if (field.options && field.name?.toLowerCase() === "status") {
      statusField = {
        id: field.id!,
        options: field.options.map((opt) => ({
          id: opt.id,
          name: opt.name,
          color: opt.color,
        })),
      };
    }

    if (field.configuration?.iterations) {
      iterationField = {
        id: field.id!,
        iterations: field.configuration.iterations.map((iter) => ({
          id: iter.id,
          title: iter.title,
          startDate: iter.startDate,
          duration: iter.duration,
        })),
      };
    }
  }

  if (!statusField) {
    throw new Error("Could not find Status field in project");
  }

  // Find current iteration (most recent that has started)
  let currentIteration: Iteration | null = null;
  if (iterationField) {
    const now = new Date();
    const activeIterations = iterationField.iterations.filter((iter) => {
      const start = new Date(iter.startDate);
      const end = new Date(start);
      end.setDate(end.getDate() + iter.duration);
      return start <= now && now <= end;
    });

    if (activeIterations.length > 0) {
      // Take the most recently started one
      currentIteration = activeIterations.sort(
        (a, b) =>
          new Date(b.startDate).getTime() - new Date(a.startDate).getTime()
      )[0];
    }
  }

  return {
    id: project.id,
    title: project.title,
    statusField,
    iterationField,
    currentIteration,
  };
}

/**
 * Fetch all issues in a project, optionally filtered to current iteration
 */
export async function fetchProjectIssues(
  accessToken: string,
  githubBaseUrl: string,
  projectInfo: ProjectInfo,
  currentIterationId: string | null
): Promise<GitHubIssue[]> {
  interface ProjectItemsResponse {
    organization: {
      projectV2: {
        items: {
          pageInfo: {
            hasNextPage: boolean;
            endCursor: string | null;
          };
          nodes: Array<{
            id: string;
            fieldValues: {
              nodes: Array<{
                name?: string;
                title?: string;
                iterationId?: string;
                field?: { name: string };
              }>;
            };
            content: {
              number?: number;
              title?: string;
              body?: string;
              url?: string;
              state?: string;
              repository?: { nameWithOwner: string };
              assignees?: { nodes: Array<{ login: string }> };
              labels?: { nodes: Array<{ name: string }> };
            } | null;
          }>;
        };
      };
    };
  }

  const allIssues: GitHubIssue[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const response: ProjectItemsResponse = await graphqlRequest<ProjectItemsResponse>(
      accessToken,
      githubBaseUrl,
      GET_PROJECT_ITEMS,
      {
        owner: projectInfo.owner,
        projectNumber: projectInfo.projectNumber,
        cursor,
      }
    );

    const items = response.organization.projectV2.items;
    hasNextPage = items.pageInfo.hasNextPage;
    cursor = items.pageInfo.endCursor;

    for (const item of items.nodes) {
      // Skip items without issue content (could be draft items)
      if (!item.content || !item.content.number) {
        continue;
      }

      // Extract status and iteration from field values
      let status = "No Status";
      let iterationId: string | null = null;

      for (const fieldValue of item.fieldValues.nodes) {
        if (fieldValue.field?.name?.toLowerCase() === "status" && fieldValue.name) {
          status = fieldValue.name;
        }
        if (fieldValue.iterationId) {
          iterationId = fieldValue.iterationId;
        }
      }

      // Filter by iteration if specified
      if (currentIterationId && iterationId !== currentIterationId) {
        continue;
      }

      const issue: GitHubIssue = {
        number: item.content.number,
        title: item.content.title || "",
        body: item.content.body || "",
        repository: item.content.repository?.nameWithOwner || "",
        url: item.content.url || "",
        status,
        state: (item.content.state as "OPEN" | "CLOSED") || "OPEN",
        assignees:
          item.content.assignees?.nodes.map((a: { login: string }) => a.login) || [],
        labels: item.content.labels?.nodes.map((l: { name: string }) => l.name) || [],
      };

      allIssues.push(issue);
    }
  }

  return allIssues;
}

/**
 * Update an issue's title and body
 */
export async function updateIssue(
  accessToken: string,
  githubBaseUrl: string,
  owner: string,
  repo: string,
  issueNumber: number,
  title: string,
  body: string
): Promise<void> {
  // First, get the issue's node ID
  interface GetIssueResponse {
    repository: {
      issue: {
        id: string;
      };
    };
  }

  const issueData = await graphqlRequest<GetIssueResponse>(
    accessToken,
    githubBaseUrl,
    GET_ISSUE,
    { owner, repo, number: issueNumber }
  );

  const issueId = issueData.repository.issue.id;

  // Now update the issue
  await graphqlRequest(accessToken, githubBaseUrl, UPDATE_ISSUE, {
    issueId,
    title,
    body,
  });
}
