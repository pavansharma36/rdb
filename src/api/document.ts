import {ConnectionId, pluginCall} from "./api.ts";


// --- Document (MongoDB) ---------------------------------------------------

export interface MongoCollection {
    database: string;
    name: string;
}

export interface FindResult {
    documents: unknown[];
    elapsed_ms: number;
}

export const document_api = {
    // Document
    docListDatabases: (connectionId: ConnectionId) =>
        pluginCall<string[]>(connectionId, "document.list_databases", {}),

    docListCollections: (connectionId: ConnectionId, database: string) =>
        pluginCall<MongoCollection[]>(connectionId, "document.list_collections", { database }),

    docFind: (
        connectionId: ConnectionId,
        database: string,
        collection: string,
        filter: string | null,
        limit: number,
    ) =>
        pluginCall<FindResult>(connectionId, "document.find", {
            database,
            collection,
            filter,
            limit,
        }),
}