/**
 * Golden queries for testing search vs grep baseline
 * 
 * Each query represents a real-world scenario where:
 * - User vocabulary differs from tool name (mismatch cases)
 * - Or user knows exact tool name (control cases)
 */

export interface GoldenQuery {
    id: string;
    category: 'mismatch' | 'control';
    query: string;
    globPattern: string;
    expectedTop3: string[]; // tool IDs in format "server/name"
    description: string;
}

export const GOLDEN_QUERIES: GoldenQuery[] = [
    // ===== MISMATCH CASES (where glob fails) =====

    {
        id: 'ticket_case_mismatch',
        category: 'mismatch',
        query: 'create a support ticket',
        globPattern: '*ticket*',
        expectedTop3: ['crm/create_case'],
        description: 'User says "ticket", tool is named "case"',
    },

    {
        id: 'refund_reverse_charge_mismatch',
        category: 'mismatch',
        query: 'refund this order',
        globPattern: '*refund*',
        expectedTop3: ['payments/reverse_charge'],
        description: 'User says "refund", tool is named "reverse_charge"',
    },

    {
        id: 'meeting_event_mismatch',
        category: 'mismatch',
        query: 'schedule a meeting tomorrow',
        globPattern: '*meeting*',
        expectedTop3: ['calendar/create_event'],
        description: 'User says "meeting", tool is named "event"',
    },

    {
        id: 'credentials_auth_mismatch',
        category: 'mismatch',
        query: 'check my credentials',
        globPattern: '*credentials*',
        expectedTop3: ['auth/verify_user'],
        description: 'User says "credentials", tool name doesn\'t contain it',
    },

    {
        id: 'repositories_code_mismatch',
        category: 'mismatch',
        query: 'search repositories for main.py',
        globPattern: '*repositories*',
        expectedTop3: ['github/find_code'],
        description: 'User says "repositories", tool is about code search',
    },

    {
        id: 'ticket_issue_mismatch',
        category: 'mismatch',
        query: 'open a ticket in jira',
        globPattern: '*ticket*',
        expectedTop3: ['jira/create_issue'],
        description: 'User says "ticket", Jira calls it "issue"',
    },

    {
        id: 'invoice_bill_mismatch',
        category: 'mismatch',
        query: 'send a bill to customer',
        globPattern: '*bill*',
        expectedTop3: ['billing/send_invoice'],
        description: 'User says "bill", tool description uses "bill" but name says "invoice"',
    },

    // ===== CONTROL CASES (where glob works fine) =====

    {
        id: 'read_file_exact',
        category: 'control',
        query: 'read file',
        globPattern: '*read*',
        expectedTop3: ['filesystem/read_file'],
        description: 'Exact vocabulary match - glob should work',
    },

    {
        id: 'create_event_exact',
        category: 'control',
        query: 'create event',
        globPattern: '*event*',
        expectedTop3: ['calendar/create_event'],
        description: 'Exact vocabulary match - glob should work',
    },

    {
        id: 'execute_query_exact',
        category: 'control',
        query: 'execute query',
        globPattern: '*query*',
        expectedTop3: ['database/execute_query'],
        description: 'Exact vocabulary match - glob should work',
    },

    // ===== NEGATIVE TEST (avoid over-claiming) =====

    {
        id: 'nonsense_query_negative',
        category: 'mismatch',
        query: 'xyzabc quantum flux capacitor',
        globPattern: '*flux*',
        expectedTop3: [], // Should return nothing or very low scores
        description: 'Nonsense query - search should not hallucinate results',
    },

    // ===== RANKING SANITY TEST =====

    {
        id: 'literal_ranking_sanity',
        category: 'control',
        query: 'database execute query',
        globPattern: '*query*',
        expectedTop3: ['database/execute_query'],
        description: 'Literal query should rank exact match #1',
    },
];
