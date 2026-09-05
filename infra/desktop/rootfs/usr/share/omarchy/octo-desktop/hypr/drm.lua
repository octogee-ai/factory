local resolution = os.getenv("OCTO_RESOLUTION") or "1920x1080"
local refresh = os.getenv("OCTO_REFRESH") or "60"

hl.monitor({ output = "", mode = resolution .. "@" .. refresh, position = "0x0", scale = 1 })
