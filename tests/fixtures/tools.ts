/**
 * Fixed tool corpus for testing vocabulary mismatch scenarios
 * 
 * This corpus includes tools where user vocabulary differs from tool names:
 * - "ticket" vs "case"
 * - "refund" vs "reverse_charge"
 * - "meeting" vs "event"
 * 
 * Also includes controls where glob should work fine.
 */

export interface TestTool {
    server: string;
    name: string;
    description: string;
}

export const TEST_CORPUS: TestTool[] = [
    // CRM tools - vocabulary mismatch: "ticket" vs "case"
    {
        server: 'crm',
        name: 'create_case',
        description: 'Create a support ticket for customer issues',
    },
    {
        server: 'crm',
        name: 'list_cases',
        description: 'List all open support cases',
    },
    {
        server: 'crm',
        name: 'close_case',
        description: 'Close a resolved support ticket',
    },
    {
        server: 'crm',
        name: 'create_customer',
        description: 'Add a new customer to the system',
    },

    // Payments - vocabulary mismatch: "refund" vs "reverse_charge"
    {
        server: 'payments',
        name: 'reverse_charge',
        description: 'Issue a refund for a completed transaction',
    },
    {
        server: 'payments',
        name: 'create_invoice',
        description: 'Generate an invoice for a customer',
    },
    {
        server: 'payments',
        name: 'process_payment',
        description: 'Process a credit card payment',
    },

    // Billing - vocabulary mismatch: "invoice" vs "bill"
    {
        server: 'billing',
        name: 'create_invoice',
        description: 'Bill a customer for services rendered',
    },
    {
        server: 'billing',
        name: 'send_invoice',
        description: 'Send bill to customer email',
    },

    // Calendar - vocabulary mismatch: "meeting" vs "event"
    {
        server: 'calendar',
        name: 'create_event',
        description: 'Schedule a meeting or appointment',
    },
    {
        server: 'calendar',
        name: 'list_events',
        description: 'Show all calendar events',
    },
    {
        server: 'calendar',
        name: 'delete_event',
        description: 'Cancel a scheduled meeting',
    },

    // Auth - vocabulary mismatch: "credentials" vs tool name
    {
        server: 'auth',
        name: 'verify_user',
        description: 'Check login credentials and permissions',
    },
    {
        server: 'auth',
        name: 'create_token',
        description: 'Generate authentication token',
    },

    // GitHub - vocabulary mismatch: "repositories" vs "code"
    {
        server: 'github',
        name: 'find_code',
        description: 'Search repositories for code patterns',
    },
    {
        server: 'github',
        name: 'list_repos',
        description: 'List all repositories',
    },

    // Jira - vocabulary mismatch: "ticket" vs "issue"
    {
        server: 'jira',
        name: 'create_issue',
        description: 'Open a support ticket in project',
    },
    {
        server: 'jira',
        name: 'assign_issue',
        description: 'Assign ticket to team member',
    },

    // Filesystem - CONTROL (glob should work fine)
    {
        server: 'filesystem',
        name: 'read_file',
        description: 'Read contents of a file',
    },
    {
        server: 'filesystem',
        name: 'write_file',
        description: 'Write data to a file',
    },
    {
        server: 'filesystem',
        name: 'delete_file',
        description: 'Remove a file from disk',
    },
    {
        server: 'filesystem',
        name: 'list_directory',
        description: 'List files in a directory',
    },

    // Database - CONTROL
    {
        server: 'database',
        name: 'execute_query',
        description: 'Run a SQL query',
    },
    {
        server: 'database',
        name: 'create_table',
        description: 'Create a new database table',
    },

    // Docs - for synonym weighting test
    {
        server: 'docs',
        name: 'read_document',
        description: 'Read a document from storage',
    },
    {
        server: 'docs',
        name: 'create_document',
        description: 'Create a new text document',
    },
];
