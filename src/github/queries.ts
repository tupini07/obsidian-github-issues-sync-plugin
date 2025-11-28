/**
 * GraphQL queries for GitHub Projects v2
 */

/**
 * Get project metadata including status field options and iterations
 * Variables: $owner: String!, $projectNumber: Int!
 */
export const GET_PROJECT_METADATA = `
query GetProjectMetadata($owner: String!, $projectNumber: Int!) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      id
      title
      fields(first: 50) {
        nodes {
          ... on ProjectV2SingleSelectField {
            id
            name
            options {
              id
              name
              color
            }
          }
          ... on ProjectV2IterationField {
            id
            name
            configuration {
              iterations {
                id
                title
                startDate
                duration
              }
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Get all items in a project, optionally filtered by iteration
 * Variables: $owner: String!, $projectNumber: Int!, $cursor: String
 */
export const GET_PROJECT_ITEMS = `
query GetProjectItems($owner: String!, $projectNumber: Int!, $cursor: String) {
  organization(login: $owner) {
    projectV2(number: $projectNumber) {
      items(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          fieldValues(first: 20) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field {
                  ... on ProjectV2SingleSelectField {
                    name
                  }
                }
              }
              ... on ProjectV2ItemFieldIterationValue {
                title
                iterationId
                field {
                  ... on ProjectV2IterationField {
                    name
                  }
                }
              }
            }
          }
          content {
            ... on Issue {
              number
              title
              body
              url
              state
              repository {
                nameWithOwner
              }
              assignees(first: 10) {
                nodes {
                  login
                }
              }
              labels(first: 10) {
                nodes {
                  name
                }
              }
            }
          }
        }
      }
    }
  }
}
`;

/**
 * Update an issue's title and body
 * Variables: $issueId: ID!, $title: String!, $body: String!
 */
export const UPDATE_ISSUE = `
mutation UpdateIssue($issueId: ID!, $title: String!, $body: String!) {
  updateIssue(input: { id: $issueId, title: $title, body: $body }) {
    issue {
      id
      number
      title
      body
    }
  }
}
`;

/**
 * Get a single issue by repo and number (for getting the node ID)
 * Variables: $owner: String!, $repo: String!, $number: Int!
 */
export const GET_ISSUE = `
query GetIssue($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      id
      number
      title
      body
      url
      state
    }
  }
}
`;
