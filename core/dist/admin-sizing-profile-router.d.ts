import { Router } from "express";
import type { PlatformStateStore } from "./platform-state/store.js";
export interface AdminSizingProfileRouterDeps {
    store: PlatformStateStore;
}
export declare function addAdminSizingProfileRoutes(router: Router, deps: AdminSizingProfileRouterDeps): Router;
