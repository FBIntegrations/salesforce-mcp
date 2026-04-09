import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { sfApiRequest } from './salesforce.js'

export function registerTools(server: McpServer, sfUserId: string) {
  // 1. sf_query — Execute SOQL query
  server.registerTool('sf_query', {
    title: 'SOQL Query',
    description:
      'Execute a SOQL query against Salesforce. Provide the complete SOQL query. Example: SELECT Id, Name FROM Account LIMIT 10',
    inputSchema: {
      query: z.string().describe('The complete SOQL query to execute'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', '/query', { q: query })
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 2. sf_get_record — Get a record by type and ID
  server.registerTool('sf_get_record', {
    title: 'Get Record',
    description:
      'Get a single Salesforce record by its object type and record ID. Returns all fields for the record.',
    inputSchema: {
      objectType: z.string().describe('The Salesforce object API name, e.g. Account, Contact, Opportunity, Task'),
      recordId: z.string().describe('The 18-character Salesforce record ID'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ objectType, recordId }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', `/sobjects/${objectType}/${recordId}`)
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 3. sf_describe_object — Get object schema
  server.registerTool('sf_describe_object', {
    title: 'Describe Object',
    description:
      'Describe a Salesforce object to get its schema including fields, field types, picklist values, and relationships. Use this before writing queries to verify field names.',
    inputSchema: {
      objectType: z.string().describe('The Salesforce object API name, e.g. Account, Contact, Opportunity, Task'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ objectType }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', `/sobjects/${objectType}/describe`)
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 4. sf_list_objects — List all available objects
  server.registerTool('sf_list_objects', {
    title: 'List Objects',
    description:
      'List all available Salesforce objects in the org. Returns the API name and label for every object. Use this to discover what objects exist.',
    annotations: { readOnlyHint: true },
  }, async () => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', '/sobjects')
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 5. sf_search_reports — Search reports by keyword
  server.registerTool('sf_search_reports', {
    title: 'Search Reports',
    description:
      'Search for Salesforce reports by name keyword. Returns matching report IDs and names. Use this to find report IDs before running them.',
    inputSchema: {
      query: z.string().describe('Search keyword to find reports by name'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ query }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', '/analytics/reports', { q: query })
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 6. sf_run_report — Execute a saved report
  server.registerTool('sf_run_report', {
    title: 'Run Report',
    description:
      'Run a Salesforce report by its ID. Returns full results with detail rows. Use sf_search_reports first if you need to find a report ID.',
    inputSchema: {
      reportId: z.string().describe('The 18-character Salesforce report ID to run'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ reportId }) => {
    const { data, error } = await sfApiRequest(
      sfUserId, 'GET', `/analytics/reports/${reportId}`, { includeDetails: 'true' },
    )
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 7. sf_get_dashboard — Get dashboard and component report IDs
  server.registerTool('sf_get_dashboard', {
    title: 'Get Dashboard',
    description:
      'Get a Salesforce dashboard by its ID. Returns all components and their underlying report IDs. Use sf_run_report to get data from each component.',
    inputSchema: {
      dashboardId: z.string().describe('The 18-character Salesforce dashboard ID'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ dashboardId }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'GET', `/analytics/dashboards/${dashboardId}`)
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 8. sf_create_record — Create a new record
  server.registerTool('sf_create_record', {
    title: 'Create Record',
    description:
      'Create a new Salesforce record. Provide the object type and fields as key-value pairs. Returns the new record ID on success.',
    inputSchema: {
      objectType: z.string().describe('The Salesforce object API name, e.g. Account, Contact, Opportunity'),
      fields: z.record(z.string(), z.any()).describe(
        'Field name-value pairs, e.g. {"Name":"Test Account","Industry":"Technology"}',
      ),
    },
  }, async ({ objectType, fields }) => {
    const { data, error } = await sfApiRequest(sfUserId, 'POST', `/sobjects/${objectType}`, undefined, fields)
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })

  // 9. sf_update_record — Update an existing record
  server.registerTool('sf_update_record', {
    title: 'Update Record',
    description:
      'Update fields on an existing Salesforce record. Provide the object type, record ID, and fields to update.',
    inputSchema: {
      objectType: z.string().describe('The Salesforce object API name, e.g. Opportunity, Task, Account, Contact'),
      recordId: z.string().describe('The 18-character Salesforce record ID'),
      fields: z.record(z.string(), z.any()).describe(
        'Field name-value pairs to update, e.g. {"StageName":"Cultivation"}',
      ),
    },
  }, async ({ objectType, recordId, fields }) => {
    const { data, error } = await sfApiRequest(
      sfUserId, 'PATCH', `/sobjects/${objectType}/${recordId}`, undefined, fields,
    )
    if (error) return { content: [{ type: 'text' as const, text: error }], isError: true }
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
  })
}
