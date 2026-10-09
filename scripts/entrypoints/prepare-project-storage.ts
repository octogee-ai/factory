import { prepareBuilderProjectStorage } from "../lib/builder-project-storage.js";

await prepareBuilderProjectStorage({ home: "/home/node", projects: "/work/materialized", slug: process.env.GATEWAY_BUILDER_SLUG ?? "" });
