/**
 * Synonym Dictionary for Search Query Expansion
 * 
 * Provides common programming and tool operation synonyms to improve
 * semantic matching without requiring embeddings.
 */

/**
 * Common programming/tool operation synonyms
 * Key: normalized token, Value: array of synonyms
 */
export const SYNONYMS: Record<string, string[]> = {
    // Authentication & Authorization
    auth: ['authenticate', 'login', 'signin', 'verify', 'credentials', 'token'],
    login: ['authenticate', 'signin', 'auth', 'verify'],
    logout: ['signout', 'deauthenticate', 'disconnect'],

    // CRUD Operations
    read: ['get', 'fetch', 'load', 'retrieve', 'view', 'show', 'display'],
    get: ['read', 'fetch', 'retrieve', 'load', 'view'],
    write: ['save', 'store', 'update', 'create', 'put', 'set', 'persist'],
    save: ['write', 'store', 'persist', 'create', 'update'],
    delete: ['remove', 'drop', 'destroy', 'erase', 'purge', 'clear'],
    remove: ['delete', 'drop', 'destroy', 'erase'],
    update: ['modify', 'change', 'edit', 'patch', 'alter', 'set'],
    create: ['add', 'new', 'make', 'generate', 'insert'],

    // Search & Query
    search: ['find', 'query', 'lookup', 'locate', 'seek', 'grep', 'filter'],
    find: ['search', 'query', 'lookup', 'locate', 'seek'],
    list: ['show', 'display', 'enumerate', 'index', 'get', 'all'],
    filter: ['search', 'find', 'query', 'select', 'match'],

    // Files & Directories
    file: ['document', 'resource', 'asset', 'content'],
    directory: ['folder', 'path', 'dir'],
    folder: ['directory', 'dir', 'path'],

    // Data & Storage
    data: ['information', 'content', 'record', 'entry'],
    cache: ['buffer', 'store', 'temporary', 'temp'],
    database: ['db', 'store', 'storage'],

    // Network & Communication
    send: ['post', 'transmit', 'deliver', 'dispatch'],
    receive: ['get', 'fetch', 'retrieve', 'accept'],
    upload: ['send', 'post', 'push', 'transfer'],
    download: ['fetch', 'get', 'pull', 'retrieve'],

    // Configuration & Settings
    config: ['configuration', 'settings', 'preferences', 'options'],
    settings: ['config', 'configuration', 'preferences', 'options'],

    // Version Control
    commit: ['save', 'push', 'submit', 'record'],
    push: ['upload', 'send', 'publish', 'deploy'],
    pull: ['fetch', 'download', 'get', 'retrieve'],

    // Common Verbs
    run: ['execute', 'start', 'launch', 'invoke'],
    execute: ['run', 'start', 'invoke', 'call'],
    stop: ['halt', 'terminate', 'kill', 'end'],
    check: ['verify', 'validate', 'test', 'inspect'],

    // Repository & Code
    repository: ['repo', 'project', 'codebase'],
    repo: ['repository', 'project'],
    branch: ['version', 'fork'],

    // User & Account
    user: ['account', 'profile', 'member'],
    account: ['user', 'profile'],
}

/**
 * Expand tokens with their synonyms
 * @param tokens - Array of normalized tokens from query
 * @returns Array of original tokens plus all their synonyms
 */
export function expandWithSynonyms(tokens: string[]): string[] {
    const expanded = new Set(tokens)

    for (const token of tokens) {
        if (SYNONYMS[token]) {
            for (const syn of SYNONYMS[token]) {
                expanded.add(syn)
            }
        }
    }

    return Array.from(expanded)
}
