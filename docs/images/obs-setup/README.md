<!-- 文件用途：记录 OBS 配置教程图片的实拍来源、标注方式和提示词，供维护与复核。 -->
# OBS 教程图片

2026-09-18 采集维护者实际运行的 OBS 32.2.2 简体中文版、便携模式窗口。只打开菜单和设置窗口；没有修改 OBS 配置、执行 OAuth 同意、开始/结束直播或录制。

`01-` 至 `09-` 文件是未标注实拍截图（不收录含个人录制目录的 `08-output.png`）。其余 PNG 基于对应实拍截图，通过内置 `image_gen` 制作编号和框选图解，未使用 CLI。`output.png` 已遮挡个人录制目录。没有公开密码、连接二维码、Token 或推流密钥。

标注图用于点击定位，不作为逐像素原始截图证据；原图与文字步骤用于核对实际菜单和填写值。截图中的 D 盘素材路径及原始码率不是新电脑必须填写的参数。教程入口：[配置.md](../../../配置.md)。

## 标注提示词

以下记录各图使用的初始提示词；总览和音频的定向修订见末尾。

### overview.png

```text
Annotate this EXACT screenshot for a beginner Chinese OBS README tutorial. Preserve screenshot pixels, UI text and layout faithfully, no recreated UI. Add bright orange outlined rectangles with small numbered badges only (no prose labels) around: 1 the scene panel + button at bottom-left of the upper left panel (x15,y326 at 1152x672); 2 the source panel + button bottom-left (x15,y621); 3 the existing LIVE scene row (x5 to270,y106 to138); 4 the two source rows VIDEO and MUSIC (x5 to272,y375 to435); 5 the Settings 设置 button at right (x978 to1143,y550 to583). Keep all original UI legible. Number badges next to each rectangle, never cover target icons. Output same screenshot aspect ratio high resolution.
```

### websocket.png

```text
Annotate this EXACT Chinese OBS WebSocket screenshot for README. Preserve ALL original UI text/layout; don't redraw or change contents. Only overlay orange numbered badges and thin rectangles: 1 around checkbox 开启 WebSocket 服务器 near (184,82); 2 around server port field 4455 (177,207 to652,239); 3 around 开启身份认证 checkbox (184,257); 4 around masked server password and 显示连接信息 button together (177,276 to655,350); 5 around 确定 button at (474,583 to533,615). Keep password masked, no secrets. Canvas 678x630 reference scaled up uniformly. No prose labels. Badges outside target text. Exact screenshot with annotation overlays only.
```

### add-media.png

```text
Annotate exact OBS screenshot without redrawing original UI or changing text/layout. Add orange outlined rectangles + badges only: badge 1 highlights left selected 媒体 row (x14 y165 width198 height33 in 1042x650 reference); badge 2 highlights top right 创建新源 button (x246 y82 width774 height62); badge 3 highlights lower-left 使源可见 checkbox (x241 y622). No prose. Preserve all image pixels outside annotations. Do not change list or names VIDEO/MUSIC.
```

### media-properties.png

```text
Annotate exact OBS VIDEO properties screenshot for tutorial. Keep original screenshot faithfully, no redesigned UI. Add orange thin rectangles and numbered badges ONLY: 1 highlights 本地文件 checkbox at x132 y319; 2 highlights 浏览 button at x631 y340 width61 height33; 3 highlights 循环 checkbox at x132 y389; 4 highlights 确定 button at x585 y564 width58 height32. Keep target labels readable, put badges in neighboring empty areas. Reference 722x610. Preserve everything including existing local file path, no prose text.
```

### audio.png

```text
Annotate exact Chinese OBS audio settings screenshot. Preserve original UI and text perfectly; overlay only orange outlines plus numbered badges: 1 selected left 音频 tab x16 y180 w172 h32; 2 large rectangle around all six disabled global audio device dropdowns x387 y204 w555 h246; 3 确定 at x780 y644 w60 h31. Original reference 984x690. Badge 2 outside rectangle, don't cover labels. No prose. Screenshot pixel faithful.
```

### video.png

```text
Annotate exact OBS Video settings screenshot; preserve original interface and all values. Overlay orange outlined boxes + small numbered badges only: 1 视频 tab x17,y214,w170,h32; 2 canvas resolution 1920x1080 field x386,y74,w504,h32; 3 output resolution1280x720 field x386,y115,w504,h32; 4 fps30 field x386,y198,w575,h35; 5 确定 x780,y644,w60,h31. Do not cover text. Original dimensions984x690. No extra prose.
```

### output.png

```text
Annotate this exact OBS Output settings screenshot keeping its UI text and layout intact. Mask ONLY the recording path value containing the Windows username in lower half with an opaque dark rectangle (x388,y405,w485,h28). Add orange outline numbered badges: 1 Output tab 输出 x16 y145 w173 h33; 2 output mode 简单 x386 y40 w585 h33; 3 video bitrate6000 field x386 y116 w558 h32; 4 audio bitrate160 field x386 y156 w558 h33; 5 video encoder 软件(x264) x386 y198 w558 h35; 6 audio encoder AAC x386 y308 w558 h36; 7 确定 x780 y644 w60 h32. No prose. Preserve all else. Original984x690.
```

### transform.png

```text
Annotate EXACT OBS screenshot preserving original screenshot UI labels/layout, only add orange outlines + numbered badges: 1 around VIDEO source row left x4 y374 w134 h31; 2 around selected 变换 menu entry x141 y397 w275 h29; 3 around submenu 比例适配屏幕(F) Ctrl+F x421 y575 w204 h31. Don't cover menu text. Original1152x672. No prose labels, no other changes.
```

### tools.png

```text
Annotate this real OBS screenshot, preserve UI layout and text. Only add orange outline and numbered circle 1 around the TOP menu item 工具(T), original x420,y23,w54,h26; and outline plus numbered circle 2 around WebSocket 服务器设置 menu row original x422,y224,w168,h30. Keep words legible, place numbers outside labels. Do not change screenshot text, do not redraw it. Only these two tutorial annotations.
```

### 总览与音频的最终定向修订

- overview：仅框选原图的场景 +（3,313,27,27）、源 +（3,607,27,28）、LIVE（4,107,272,30）、VIDEO/MUSIC（3,374,269,61）、右下全局设置（976,551,169,32），对应 1～5。不得误标预览下方的源设置。
- audio：保留左侧音频、六个全局设备、确定按钮的 1～3 标注；明确六项值均为“已禁用”，保持 48 kHz 和立体声。
