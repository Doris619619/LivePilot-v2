/** 窗口缩放回归：验证实际安装的键盘监听、浏览器比例阶梯及未消费按键的边界。 */
import type { Input } from "electron";
import { describe, expect, it, vi } from "vitest";
import { installWindowZoom } from "../electron/window-zoom";

type KeyboardListener = (event: { preventDefault(): void }, input: Input) => void;

/** 仅模拟 Electron 的事件及缩放接口，不启动桌面程序、Agent 或任何真实设备操作。 */
function fixture(initialFactor = 1) {
  let factor = initialFactor;
  const webContents = {
    on: vi.fn(),
    getZoomFactor: vi.fn(() => factor),
    setZoomFactor: vi.fn((next: number) => { factor = next; }),
  };
  installWindowZoom(webContents as unknown as Parameters<typeof installWindowZoom>[0]);
  expect(webContents.on).toHaveBeenCalledExactlyOnceWith("before-input-event", expect.any(Function));
  const listener = webContents.on.mock.calls[0][1] as KeyboardListener;
  return {
    webContents,
    /** 发出 Electron 输入事件，返回是否消费该按键以核验页面和菜单不会重复缩放。 */
    press(input: Partial<Input>) {
      const event = { preventDefault: vi.fn() };
      listener(event, { type: "keyDown", key: "=", code: "Equal", control: true, shift: false, alt: false, meta: false, isComposing: false, isAutoRepeat: false, location: 0, modifiers: ["control"], ...input });
      return event;
    },
  };
}

describe("window zoom keyboard combinations", () => {
  it.each([
    { key: "=", code: "Equal" },
    { key: "+", code: "Equal", shift: true },
    { key: "+", code: "NumpadAdd", location: 3 },
    { key: "Add", code: "NumpadAdd", location: 3 },
  ])("zooms in for Ctrl + $key ($code)", input => {
    const { webContents, press } = fixture();
    expect(press(input).preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1.1);
  });

  it.each([
    { key: "-", code: "Minus" },
    { key: "-", code: "NumpadSubtract", location: 3 },
    { key: "Subtract", code: "NumpadSubtract", location: 3 },
  ])("zooms out for Ctrl + $key ($code)", input => {
    const { webContents, press } = fixture();
    expect(press(input).preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(0.9);
  });

  it.each([
    { key: "0", code: "Digit0" },
    { key: "0", code: "Numpad0", location: 3 },
  ])("restores 100% for Ctrl + 0 ($code)", input => {
    const { webContents, press } = fixture(1.75);
    expect(press(input).preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("prevents native menu handling before changing the factor", () => {
    const { webContents, press } = fixture();
    const event = press({});
    expect(event.preventDefault.mock.invocationCallOrder[0]).toBeLessThan(webContents.setZoomFactor.mock.invocationCallOrder[0]);
  });
});

describe("window zoom factors", () => {
  it("steps repeatedly through browser zoom factors and remains within 50%-200%", () => {
    const { webContents, press } = fixture();
    for (let index = 0; index < 8; index++) expect(press({ isAutoRepeat: index > 0 }).preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setZoomFactor.mock.calls.map(([factor]) => factor)).toEqual([1.1, 1.25, 1.5, 1.75, 2, 2, 2, 2]);
    webContents.setZoomFactor.mockClear();
    for (let index = 0; index < 13; index++) expect(press({ key: "-", code: "Minus", isAutoRepeat: index > 0 }).preventDefault).toHaveBeenCalledOnce();
    expect(webContents.setZoomFactor.mock.calls.map(([factor]) => factor)).toEqual([1.75, 1.5, 1.25, 1.1, 1, 0.9, 0.8, 0.75, 0.67, 0.5, 0.5, 0.5, 0.5]);
  });

  it.each([
    { initial: 1.2, key: "=", expected: 1.25 },
    { initial: 1.2, key: "-", expected: 1.1 },
    { initial: 1.1000000000000001, key: "=", expected: 1.25 },
    { initial: 0.9999999999999999, key: "-", expected: 0.9 },
  ])("moves from $initial to $expected with Ctrl + $key", ({ initial, key, expected }) => {
    const { webContents, press } = fixture(initial);
    press({ key });
    expect(webContents.setZoomFactor).toHaveBeenCalledExactlyOnceWith(expected);
  });
});

describe("unhandled keyboard events", () => {
  it.each([
    { control: false },
    { control: false, meta: true },
    { alt: true },
    { meta: true },
    { isComposing: true },
    { type: "keyUp" },
    { key: "c", code: "KeyC" },
    { key: "_", code: "Minus", shift: true },
    { key: ")", code: "Digit0", shift: true },
    { key: "Insert", code: "Numpad0", location: 3 },
  ])("preserves other page and system input: %j", input => {
    const { webContents, press } = fixture();
    expect(press(input).preventDefault).not.toHaveBeenCalled();
    expect(webContents.getZoomFactor).not.toHaveBeenCalled();
    expect(webContents.setZoomFactor).not.toHaveBeenCalled();
  });
});
