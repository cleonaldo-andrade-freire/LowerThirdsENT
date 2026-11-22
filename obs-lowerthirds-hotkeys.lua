--[[
  Lower Thirds ENT — teclas de atalho no OBS Studio
  ---------------------------------------------------
  Cria entradas em  Configurações → Teclas de atalho:
    • Lower Thirds: TAKE (dados atuais)
    • Lower Thirds: HIDE
    • Lower Thirds: TOGGLE (exibir/ocultar)
    • Lower Thirds: Slot 1 … Slot 20

  Instalação: OBS → Ferramentas → Scripts → "+" → selecione este arquivo.
  Depois defina as teclas em Configurações → Teclas de atalho (procure "Lower Thirds").

  As chamadas vão para a API local (padrão http://127.0.0.1:3000).
  No Windows usa o curl.exe do próprio sistema, em segundo plano (sem abrir janela).
]]

local obs = obslua
local ffi_ok, ffi = pcall(require, "ffi")

local SLOT_COUNT = 20
local server_url = "http://127.0.0.1:3000"
local hotkeys = {}   -- { key = { id = <hotkey id>, path = "/api/..." } }

---------------------------------------------------------------------------
-- Execução da requisição HTTP sem bloquear o OBS
---------------------------------------------------------------------------
local is_windows = package.config:sub(1, 1) == "\\"
local win_ready = false

if is_windows and ffi_ok then
  -- pcall: o OBS pode recarregar o script e ffi.cdef não aceita redefinir tipos
  pcall(ffi.cdef, [[
    typedef struct {
      uint32_t cb; char* lpReserved; char* lpDesktop; char* lpTitle;
      uint32_t dwX; uint32_t dwY; uint32_t dwXSize; uint32_t dwYSize;
      uint32_t dwXCountChars; uint32_t dwYCountChars; uint32_t dwFillAttribute; uint32_t dwFlags;
      uint16_t wShowWindow; uint16_t cbReserved2; uint8_t* lpReserved2;
      void* hStdInput; void* hStdOutput; void* hStdError;
    } LT_STARTUPINFOA;
    typedef struct { void* hProcess; void* hThread; uint32_t dwProcessId; uint32_t dwThreadId; } LT_PROCESS_INFORMATION;
    int CreateProcessA(const char* app, char* cmd, void* pa, void* ta, int inherit, uint32_t flags,
                       void* env, const char* cwd, LT_STARTUPINFOA* si, LT_PROCESS_INFORMATION* pi);
    int CloseHandle(void* h);
  ]])
  win_ready = pcall(function() return ffi.C.CreateProcessA end)
end

local CREATE_NO_WINDOW = 0x08000000

local function curl_path()
  local root = os.getenv("SystemRoot") or "C:\\Windows"
  return root .. "\\System32\\curl.exe"
end

local function post(path)
  local url = server_url:gsub("/+$", "") .. path
  if not url:match("^https?://[%w%.%-:%[%]]+/[%w%./%-_]*$") then
    obs.script_log(obs.LOG_WARNING, "[Lower Thirds] URL inválida: " .. url)
    return
  end

  if is_windows and win_ready then
    local cmd = string.format('"%s" -s -m 3 -X POST "%s"', curl_path(), url)
    local buf = ffi.new("char[?]", #cmd + 1)
    ffi.copy(buf, cmd)
    local si = ffi.new("LT_STARTUPINFOA")
    si.cb = ffi.sizeof(si)
    local pi = ffi.new("LT_PROCESS_INFORMATION")
    local ok = ffi.C.CreateProcessA(nil, buf, nil, nil, 0, CREATE_NO_WINDOW, nil, nil, si, pi)
    if ok ~= 0 then
      ffi.C.CloseHandle(pi.hThread)
      ffi.C.CloseHandle(pi.hProcess)
    else
      obs.script_log(obs.LOG_WARNING, "[Lower Thirds] Não foi possível executar o curl.exe (Windows 10 1803+ necessário).")
    end
  elseif is_windows then
    os.execute(string.format('start "" /b "%s" -s -m 3 -X POST "%s"', curl_path(), url))
  else
    -- macOS / Linux: curl em segundo plano
    os.execute(string.format("curl -s -m 3 -X POST '%s' >/dev/null 2>&1 &", url))
  end
end

---------------------------------------------------------------------------
-- Teclas de atalho
---------------------------------------------------------------------------
local function register(key, description, path)
  local id = obs.obs_hotkey_register_frontend("lowerthirds_" .. key, description, function(pressed)
    if pressed then post(path) end
  end)
  hotkeys[key] = { id = id, path = path }
end

local function register_all()
  register("take", "Lower Thirds: TAKE (dados atuais)", "/api/take")
  register("hide", "Lower Thirds: HIDE", "/api/hide")
  register("toggle", "Lower Thirds: TOGGLE (exibir/ocultar)", "/api/toggle")
  for i = 1, SLOT_COUNT do
    register(string.format("slot%02d", i), string.format("Lower Thirds: Slot %d", i), "/api/take/slot/" .. i)
  end
end

---------------------------------------------------------------------------
-- Ciclo de vida do script
---------------------------------------------------------------------------
function script_description()
  return [[<h3>Lower Thirds ENT — Teclas de atalho</h3>
<p>Defina as teclas em <b>Configurações → Teclas de atalho</b>, procurando por <b>"Lower Thirds"</b>.</p>
<p>O servidor do Lower Thirds precisa estar rodando (iniciar.bat).</p>]]
end

function script_properties()
  local props = obs.obs_properties_create()
  obs.obs_properties_add_text(props, "server_url", "Endereço do servidor", obs.OBS_TEXT_DEFAULT)
  obs.obs_properties_add_button(props, "test_slot1", "Testar: TAKE no Slot 1", function() post("/api/take/slot/1") return false end)
  obs.obs_properties_add_button(props, "test_hide", "Testar: HIDE", function() post("/api/hide") return false end)
  return props
end

function script_defaults(settings)
  obs.obs_data_set_default_string(settings, "server_url", "http://127.0.0.1:3000")
end

function script_update(settings)
  local url = obs.obs_data_get_string(settings, "server_url")
  if url and url ~= "" then server_url = url end
end

function script_load(settings)
  register_all()
  for key, hk in pairs(hotkeys) do
    local arr = obs.obs_data_get_array(settings, "lt_hotkey_" .. key)
    obs.obs_hotkey_load(hk.id, arr)
    obs.obs_data_array_release(arr)
  end
  script_update(settings)
  if is_windows and not win_ready then
    obs.script_log(obs.LOG_WARNING, "[Lower Thirds] FFI indisponível; usando os.execute (pode piscar uma janela).")
  end
end

function script_save(settings)
  for key, hk in pairs(hotkeys) do
    local arr = obs.obs_hotkey_save(hk.id)
    obs.obs_data_set_array(settings, "lt_hotkey_" .. key, arr)
    obs.obs_data_array_release(arr)
  end
end
