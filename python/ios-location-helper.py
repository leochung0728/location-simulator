#!/usr/bin/env python3
"""
ios-location-helper.py

常駐的 iOS 定位助手。維持一條開著的裝置連線，透過 stdin/stdout 以
逐行 JSON 收發指令，供上層（Electron / Node 的 ios-adapter.ts）呼叫。

底層使用 pymobiledevice3 的 DVT LocationSimulation —— 這是 Apple 開發者
服務提供的定位模擬機制（與 Xcode 模擬定位相同），用途為定位功能測試。

連線解析順序：
  1. iOS 17+：透過背景執行的 tunneld 取得 RemoteServiceDiscovery（RSD）
     需先以系統管理員權限執行： sudo pymobiledevice3 remote tunneld
  2. iOS 16 以下：退回使用 usbmux lockdown
     需已掛載 Developer Disk Image（DDI）

stdin 指令（每行一個 JSON）：
  {"id":1, "cmd":"set",   "lat":25.03, "lng":121.53}
  {"id":2, "cmd":"clear"}
  {"id":3, "cmd":"ping"}
  {"id":4, "cmd":"quit"}

stdout 回應（每行一個 JSON）：
  {"event":"ready", "transport":"rsd", "udid":"..."}      # 啟動成功
  {"id":1, "ok":true}
  {"id":2, "ok":false, "error":"..."}
  {"event":"fatal", "error":"..."}                         # 啟動失敗
"""
import argparse
import asyncio
import json
import sys


def emit(obj: dict) -> None:
    """輸出一行 JSON 並立即 flush。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


async def resolve_service_provider(udid: str | None, wait_tunnel: bool = False):
    """
    解析出可用的 service provider。回傳 (provider, transport)；失敗時拋出例外。
    wait_tunnel=True（App 自動啟動 tunnel 時）會多輪詢一段時間，
    等裝置的 tunnel 建立好再回傳，避免太早連線拿到 InvalidService。
    """
    import time as _time
    from pymobiledevice3.tunneld.api import (
        get_tunneld_device_by_udid,
        get_tunneld_devices,
    )

    # ── iOS 17+：tunneld / RSD（必要時輪詢等待）──
    deadline = _time.monotonic() + (25.0 if wait_tunnel else 1.0)
    delay = 0.25
    while True:
        try:
            if udid:
                rsd = await get_tunneld_device_by_udid(udid)
            else:
                devices = await get_tunneld_devices()
                rsd = devices[0] if devices else None
            if rsd:
                return rsd, "rsd"
        except Exception:
            pass
        if _time.monotonic() >= deadline:
            break
        await asyncio.sleep(delay)
        delay = min(delay * 1.5, 2.0)   # 漸進退讓：0.25→0.375→…→上限 2s（快取得、又不洪水）

    emit({"event": "info", "message": "未偵測到 tunnel，改用 usbmux"})

    # ── iOS 16 以下：usbmux lockdown（需已掛載 DDI）──
    from pymobiledevice3.lockdown import create_using_usbmux
    lockdown = await create_using_usbmux(serial=udid)
    return lockdown, "usbmux"


async def read_line() -> str | None:
    """在 executor 中非阻塞地讀取一行 stdin。"""
    loop = asyncio.get_event_loop()
    line = await loop.run_in_executor(None, sys.stdin.readline)
    return line if line else None


async def _maybe_await(x):
    """相容 pymobiledevice3 同步/非同步介面：是 awaitable 就 await。"""
    import inspect
    if inspect.isawaitable(x):
        return await x
    return x


async def list_devices_action() -> int:
    """
    列出目前可見的 iOS 裝置（USB 與 WiFi 合併），盡力補上名稱與 iOS 版本，
    並標記哪些已透過 tunneld 建立通道（iOS 17+ 可直接連）。
    輸出一行： {"event":"devices","devices":[{udid,name,iosVersion,connection,tunnelReady}]}
    """
    seen: dict[str, dict] = {}

    # iOS 17+：tunneld 已建通道的裝置
    tunnel_udids: set[str] = set()
    try:
        from pymobiledevice3.tunneld.api import get_tunneld_devices
        for rsd in await get_tunneld_devices():
            u = getattr(rsd, "udid", None)
            if u:
                tunnel_udids.add(u)
                seen[u] = {
                    "udid": u, "name": None,
                    "iosVersion": getattr(rsd, "product_version", None),
                    "connection": "wifi", "tunnelReady": True,
                }
    except Exception:
        pass

    # usbmux：USB 與 Network（WiFi 同步）裝置（先建條目，名稱/版本稍後並行補）
    usbmux_udids: list[str] = []
    try:
        from pymobiledevice3.usbmux import list_devices
        for d in (await _maybe_await(list_devices())) or []:
            u = getattr(d, "serial", None) or getattr(d, "udid", None)
            if not u:
                continue
            ct = (getattr(d, "connection_type", "") or "").lower()
            conn = "usb" if "usb" in ct else "wifi"
            info = seen.get(u) or {
                "udid": u, "name": None, "iosVersion": None,
                "connection": conn, "tunnelReady": u in tunnel_udids,
            }
            if conn == "usb":
                info["connection"] = "usb"   # 實體連線優先標示
            seen[u] = info
            if u not in usbmux_udids:
                usbmux_udids.append(u)
    except Exception as e:
        emit({"event": "info", "message": f"usbmux 列舉失敗：{e}"})

    # 並行補名稱 / 版本：每台各一次 lockdown，平行做以縮短多台時的總時間。
    async def _fill_info(u: str) -> None:
        try:
            from pymobiledevice3.lockdown import create_using_usbmux
            ld = await _maybe_await(create_using_usbmux(serial=u, autopair=False))
            si = getattr(ld, "short_info", None) or {}
            if si.get("DeviceName"):
                seen[u]["name"] = si.get("DeviceName")
            if si.get("ProductVersion"):
                seen[u]["iosVersion"] = si.get("ProductVersion")
        except Exception:
            pass

    if usbmux_udids:
        await asyncio.gather(*[_fill_info(u) for u in usbmux_udids])

    emit({"event": "devices", "devices": list(seen.values())})
    return 0


async def wifi_on_action(udid: str | None) -> int:
    """對指定裝置開啟「透過 WiFi 連線」（等同 pymobiledevice3 lockdown wifi-connections on）。"""
    try:
        from pymobiledevice3.lockdown import create_using_usbmux
        ld = await _maybe_await(create_using_usbmux(serial=udid))
        try:
            await _maybe_await(ld.set_enable_wifi_connections(True))   # 9.x 正確方法
        except AttributeError:
            try:
                await _maybe_await(ld.enable_wifi_connections(True))    # 舊版方法
            except AttributeError:
                await _maybe_await(
                    ld.set_value(True, "EnableWifiConnections", "com.apple.mobile.wireless_lockdown")
                )
        emit({"event": "wifi-on", "ok": True, "udid": udid})
        return 0
    except Exception as e:
        emit({"event": "wifi-on", "ok": False, "error": str(e)})
        return 1


async def serve(location_sim) -> None:
    """主迴圈：讀取指令、操作 LocationSimulation、回傳結果。"""
    while True:
        line = await read_line()
        if line is None:  # stdin 關閉
            break
        line = line.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            emit({"ok": False, "error": "invalid json"})
            continue

        rid = req.get("id")
        cmd = req.get("cmd")

        try:
            if cmd == "set":
                await location_sim.set(float(req["lat"]), float(req["lng"]))
                emit({"id": rid, "ok": True})
            elif cmd == "clear":
                await location_sim.clear()
                emit({"id": rid, "ok": True})
            elif cmd == "ping":
                emit({"id": rid, "ok": True, "pong": True})
            elif cmd == "quit":
                emit({"id": rid, "ok": True})
                break
            else:
                emit({"id": rid, "ok": False, "error": f"unknown cmd: {cmd}"})
        except Exception as e:
            emit({"id": rid, "ok": False, "error": str(e)})


async def main(udid: str | None, wait_tunnel: bool = False) -> int:
    from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
    from pymobiledevice3.services.dvt.instruments.location_simulation import (
        LocationSimulation,
    )

    try:
        provider, transport = await resolve_service_provider(udid, wait_tunnel)
    except Exception as e:
        emit({"event": "fatal", "error": f"無法連接裝置：{e}"})
        return 1

    resolved_udid = getattr(provider, "udid", None) or udid

    try:
        async with DvtProvider(provider) as dvt:
            async with LocationSimulation(dvt) as location_sim:
                emit({"event": "ready", "transport": transport, "udid": resolved_udid})
                await serve(location_sim)
                # 結束前清除模擬定位，讓裝置回到真實 GPS
                try:
                    await location_sim.clear()
                except Exception:
                    pass
    except Exception as e:
        emit({"event": "fatal", "error": f"DVT 服務建立失敗：{e}"})
        return 1

    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--udid", default=None, help="指定裝置 UDID（不指定則用第一台）")
    ap.add_argument("--wait-tunnel", action="store_true",
                    help="多等候一段時間讓 tunnel 建立（App 自動啟動 tunnel 時使用）")
    ap.add_argument("--list", action="store_true", help="列出可見裝置後結束")
    ap.add_argument("--wifi-on", action="store_true",
                    help="對指定裝置開啟 WiFi 連線後結束")
    args = ap.parse_args()
    try:
        if args.list:
            sys.exit(asyncio.run(list_devices_action()))
        elif getattr(args, "wifi_on", False):
            sys.exit(asyncio.run(wifi_on_action(args.udid)))
        else:
            sys.exit(asyncio.run(main(args.udid, args.wait_tunnel)))
    except KeyboardInterrupt:
        sys.exit(0)