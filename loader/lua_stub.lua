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
    -- Legacy path (C++ loader uses POST /api/auth with AES envelope).
    -- In-game flow uses the handshake below; kept for reference only.
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

local function httpGet(url)
    local ok, res = pcall(request, { Url = url, Method = "GET" })
    if not ok or not res then return nil end
    if (res.StatusCode or res.Status_code or 0) ~= 200 then return nil, res.Body end
    return res.Body
end

local function httpPost(url, tbl)
    local ok, res = pcall(request, {
        Url = url,
        Method = "POST",
        Headers = { ["Content-Type"] = "application/json" },
        Body = game:GetService("HttpService"):JSONEncode(tbl),
    })
    if not ok or not res then return nil end
    if (res.StatusCode or res.Status_code or 0) ~= 200 then return nil, res.Body end
    return res.Body
end

-- Challenge math — must match server/handshake.js exactly.
local function GetExpected(rngSeed, nonce, timeBucket)
    local MOD = 900000000000
    local x = rngSeed % MOD
    local n = nonce % MOD
    local t = timeBucket % MOD
    x = (x * 191 + n * 163 + t * 97 + 59) % MOD
    local digits = x
    while digits > 0 do
        local digit = digits % 10
        for _ = 1, 4 do
            if digit % 2 == 0 then x = (x * 73 + n * 29 + t * 11 + digit + 11) % MOD
            else x = (x * 97 + n * 17 + t * 7 + digit + 37) % MOD end
            if (x + t) % 3 == 0 then x = (x + n * 113 + t * 17) % MOD
            elseif (x + t) % 3 == 1 then x = (x * 31 + n * 17 + t * 19 + 73) % MOD
            else x = (x * 43 + n * 29 + t * 13 + 131) % MOD end
            if digit % 5 == 0 then x = (x * 41 + t * 23 + digit + 12345) % MOD
            else x = (x * 53 + n * 19 + t * 31 + digit + 6789) % MOD end
            if (x + t) % 7 < 3 then x = (x * 19 + n * 23 + t * 29 + 123) % MOD
            else x = (x * 37 + n * 13 + t * 41 + 4567) % MOD end
        end
        digits = math.floor(digits / 10)
    end
    return math.floor(x)
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

-- ── Authenticate → fetch wrapped script → run ──────
-- Server verifies every step; only it can mint a valid reply,
-- and every delivery carries a fresh polymorphic wrapper.
local function handleKeyError(body)
    local err = tostring(body or "FAILED")
    if err == "CHECKPOINT_REQUIRED" or err == "KEY_EXPIRED" or err == "MAX_USES_REACHED" then
        revealKeySite(err == "KEY_EXPIRED" and "Key expired (24h). " or "")
    elseif err == "INVALID_KEY" then
        setStatus("Invalid license key.", Color3.fromRGB(239, 68, 68))
    elseif err == "KEY_BLACKLISTED" or err == "KEY_DISABLED" or err == "PROJECT_KILLED" then
        setStatus("Key rejected by server.", Color3.fromRGB(239, 68, 68))
    else
        setStatus("Error: " .. err, Color3.fromRGB(239, 68, 68))
    end
end

submitBtn.MouseButton1Click:Connect(function()
    local key = keyBox.Text:gsub("%s+", "")
    if key == "" then setStatus("Enter your key first.") return end
    local hwid = getHWID()

    setStatus("Verifying…")
    local seed = math.floor(math.random() * 899999999999) + 1
    local nonceBody, nonceErr = httpGet(API_URL .. "/nonce2?rngSeed=" .. seed .. "&key=" .. key)
    local nonce = tonumber(nonceBody or "")
    if not nonce then handleKeyError(nonceBody or nonceErr) return end

    local bucket = math.floor(os.time() / 15)
    local expected = GetExpected(seed, nonce, bucket)
    local replyBody = httpGet(API_URL .. "/auth7?response=" .. expected)
    local reply = tonumber(replyBody or "")
    if not reply then setStatus("Auth mismatch.", Color3.fromRGB(239, 68, 68)) return end

    setStatus("Downloading…")
    local chunk, fetchErr = httpPost(API_URL .. "/fetch", { key = key, hwid = hwid, reply = reply })
    if not chunk or #chunk < 64 then handleKeyError(fetchErr) return end

    setStatus("Loading…")
    local fn, lerr = loadstring(chunk)
    if not fn then setStatus("Corrupt payload.", Color3.fromRGB(239, 68, 68)) return end

    frame.Visible = false
    local ok, rerr = pcall(fn, reply, key, hwid, API_URL)
    if not ok then
        frame.Visible = true
        setStatus("Script error.", Color3.fromRGB(239, 68, 68))
    end
end)
