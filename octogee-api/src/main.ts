import { createPlatformApp } from "./app.js";
import { serveApi } from "./serve.js";

serveApi(createPlatformApp());
