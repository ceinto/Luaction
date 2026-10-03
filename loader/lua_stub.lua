-- ═══════════════════════════════════════════════════
--  Luaction — In-game key loader (no browser needed)
--  Paste your key, or press Get Key to reveal the key
--  website URL (copy it, open it on your phone / PC).
-- ═══════════════════════════════════════════════════

local PROJECT_ID  = "__PROJECT_ID__"
local API_URL     = "__API_URL__" -- e.g. https://your-api.onrender.com/api (no trailing slash)
local KEY_SITE_URL = API_URL:gsub("/api$", "") .. "/loader/checkpoint.html?project=" .. PROJECT_ID

if getgenv().__LUACTION_LOADED then return end
getgenv().__LUACTION_LOADED = true

-- ── Executor-safe helpers ────────────────────────────
local request = (syn and syn.request) or (http and http.request) or request or http_request
assert(request, "[Luaction] executor has no http request function")

local function getHWID()
    if gethwid then local ok, v = pcall(gethwid) if ok and v then return tostring(v) end end
    local ok, v = pcall(function()
        return game:GetService("RbxAnalyticsService"):GetClientId()
    end)
    if ok and v then return tostring(v) end
    return "unknown"
end

local function copyText(s)
    if setclipboard then pcall(setclipboard, s) return true end
    return false
end

local function authRequest(key)
    local res = request({
        Url = API_URL .. "/auth",
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = game:GetService("HttpService"):JSONEncode({
            key = key,
            hwid = getHWID(),
            version = "1.0.0",
        }),
    })
    local ok, data = pcall(function()
        return game:GetService("HttpService"):JSONDecode(res.Body)
    end)
    return res.StatusCode, ok and data or {}
end

-- ── GUI (pure Roblox instances, no UI library) ───────
local parent
do
    local ok, hui = pcall(function()
        return (gethui and gethui()) or (get_hidden_gui and get_hidden_gui()) or nil
    end)
    parent = (ok and hui) or game:GetService("CoreGui")
    if not pcall(function() parent:GetChildren() end) then
        parent = game:GetService("Players").LocalPlayer:WaitForChild("PlayerGui")
    end
end

local gui = Instance.new("ScreenGui")
gui.Name = "LuactionLoader"
gui.ResetOnSpawn = false
gui.ZIndexBehavior = Enum.ZIndexBehavior.Sibling
gui.Parent = parent

local frame = Instance.new("Frame")
frame.Size = UDim2.new(0, 320, 0, 250)
frame.Position = UDim2.new(0.5, -160, 0.5, -125)
frame.BackgroundColor3 = Color3.fromRGB(22, 23, 28)
frame.BorderSizePixel = 0
frame.Active = true
frame.Parent = gui
Instance.new("UICorner", frame).CornerRadius = UDim.new(0, 12)

local title = Instance.new("TextLabel")
title.Size = UDim2.new(1, 0, 0, 40)
title.BackgroundTransparency = 1
title.Font = Enum.Font.GothamBold
title.TextSize = 15
title.TextColor3 = Color3.fromRGB(255, 255, 255)
title.Text = "Enter License Key"
title.Parent = frame

do -- drag by title bar
    local dragging, startPos, startInput
    title.InputBegan:Connect(function(i)
        if i.UserInputType == Enum.UserInputType.MouseButton1 then
            dragging = true startInput = i.Position startPos = frame.Position
            i.Changed:Connect(function()
                if i.UserInputState == Enum.UserInputState.End then dragging = false end
            end)
        end
    end)
    game:GetService("UserInputService").InputChanged:Connect(function(i)
        if dragging and i.UserInputType == Enum.UserInputType.MouseMovement then
            local d = i.Position - startInput
            frame.Position = UDim2.new(startPos.X.Scale, startPos.X.Offset + d.X, startPos.Y.Scale, startPos.Y.Offset + d.Y)
        end
    end)
end

local function makeBox(y, placeholder)
    local b = Instance.new("TextBox")
    b.Size = UDim2.new(1, -32, 0, 36)
    b.Position = UDim2.new(0, 16, 0, y)
    b.BackgroundColor3 = Color3.fromRGB(255, 255, 255, 0.06)
    b.Font = Enum.Font.Code
    b.TextSize = 13
    b.TextColor3 = Color3.fromRGB(226, 228, 233)
    b.PlaceholderColor3 = Color3.fromRGB(255, 255, 255, 0.25)
    b.PlaceholderText = placeholder
    b.Text = ""
    b.ClearTextOnFocus = false
    b.Parent = frame
    Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
    return b
end

local function makeBtn(y, text, color)
    local b = Instance.new("TextButton")
    b.Size = UDim2.new(1, -32, 0, 34)
    b.Position = UDim2.new(0, 16, 0, y)
    b.BackgroundColor3 = color
    b.Font = Enum.Font.GothamMedium
    b.TextSize = 13
    b.TextColor3 = Color3.fromRGB(255, 255, 255)
    b.Text = text
    b.AutoButtonColor = true
    b.Parent = frame
    Instance.new("UICorner", b).CornerRadius = UDim.new(0, 8)
    return b
end

local keyBox    = makeBox(48, "XXXX-XXXX-XXXX-XXXX")
local submitBtn = makeBtn(92, "Submit", Color3.fromRGB(59, 130, 246))
local getKeyBtn = makeBtn(132, "Get Key", Color3.fromRGB(139, 92, 246))
local urlBox    = makeBox(174, "key website URL")
urlBox.Visible = false
urlBox.TextEditable = false

local status = Instance.new("TextLabel")
status.Size = UDim2.new(1, -32, 0, 20)
status.Position = UDim2.new(0, 16, 0, 216)
status.BackgroundTransparency = 1
status.Font = Enum.Font.Gotham
status.TextSize = 11
status.TextColor3 = Color3.fromRGB(255, 255, 255, 0.4)
status.Text = ""
status.Parent = frame

local function setStatus(text, color)
    status.Text = text
    status.TextColor3 = color or Color3.fromRGB(255, 255, 255, 0.4)
end

local function revealKeySite(reason)
    urlBox.Visible = true
    urlBox.Text = KEY_SITE_URL
    frame.Size = UDim2.new(0, 320, 0, 250)
    if copyText(KEY_SITE_URL) then
        setStatus((reason or "") .. "Key site link copied — open it in a browser.")
    else
        setStatus((reason or "") .. "Copy the link above, open it in a browser.")
    end
end

getKeyBtn.MouseButton1Click:Connect(function()
    revealKeySite("")
end)

-- ── What happens after a successful auth ─────────────
-- data = { status="OK", nonce=..., payload={iv,tag,data}, version=... }
-- The payload is AES-256-GCM encrypted for your HWID. Decrypt it with
-- your own loader, or replace this with loadstring(game:HttpGet(...)).
local function onAuthSuccess(data)
    setStatus("Authenticated ✓", Color3.fromRGB(16, 185, 129))
    task.wait(0.6)
    gui:Destroy()
    -- TODO: handle data.payload here (decrypt + execute your script)
    print("[Luaction] auth OK, version " .. tostring(data.version))
end

submitBtn.MouseButton1Click:Connect(function()
    local key = keyBox.Text:gsub("%s+", "")
    if key == "" then setStatus("Enter your key first.") return end
    setStatus("Verifying…")
    local code, data = authRequest(key)
    if code == 200 and data.status == "OK" then
        onAuthSuccess(data)
        return
    end
    local err = tostring(data.error or "FAILED")
    if err == "CHECKPOINT_REQUIRED" or err == "KEY_EXPIRED" or err == "MAX_USES_REACHED" then
        revealKeySite(err == "KEY_EXPIRED" and "Key expired (24h). " or "")
    elseif err == "INVALID_KEY" then
        setStatus("Invalid license key.", Color3.fromRGB(239, 68, 68))
    elseif err == "HWID_MISMATCH" then
        setStatus("Key locked to another device.", Color3.fromRGB(239, 68, 68))
    else
        setStatus(data.message or ("Error: " .. err), Color3.fromRGB(239, 68, 68))
    end
end)
