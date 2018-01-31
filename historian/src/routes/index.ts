import { Router } from "express";
import * as nconf from "nconf";
import { StorageProvider } from "../services";
import * as blobs from "./git/blobs";
import * as commits from "./git/commits";
import * as refs from "./git/refs";
import * as repos from "./git/repos";
import * as tags from "./git/tags";
import * as trees from "./git/trees";
import * as repositoryCommits from "./repository/commits";
import * as contents from "./repository/contents";
import * as headers from "./repository/headers";

export interface IRoutes {
    git: {
        blobs: Router;
        commits: Router;
        refs: Router;
        repos: Router;
        tags: Router;
        trees: Router;
    };
    repository: {
        commits: Router;
        contents: Router;
        headers: Router;
    };
}

export function create(
    store: nconf.Provider,
    provider: StorageProvider): IRoutes {

    return {
        git: {
            blobs: blobs.create(store, provider),
            commits: commits.create(store, provider),
            refs: refs.create(store, provider),
            repos: repos.create(store, provider),
            tags: tags.create(store, provider),
            trees: trees.create(store, provider),
        },
        repository: {
            commits: repositoryCommits.create(store, provider),
            contents: contents.create(store, provider),
            headers: headers.create(store, provider),
        },
    };
}
