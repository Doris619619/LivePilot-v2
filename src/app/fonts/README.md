<!-- 文件用途：说明自托管字体来源、许可证、字符范围与再生成方式。 -->
# LiveNest Sans SC

基于 Noto Sans SC 可变字体制作的应用子集，派生字体命名为 LiveNest Sans SC。来源文件版本：Version 2.04;241114210130;non-release；原文件 SHA256：763146584cf0710223441356b4395e279021b0806c196614377a7a0174ae074a。

版权：© 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'。按 SIL Open Font License 1.1 分发，全文见 [OFL.txt](OFL.txt)；来源许可证：[google/fonts](https://github.com/google/fonts/blob/main/ofl/notosanssc/OFL.txt)。原字体的版权与许可元数据保留在 WOFF2 中。

保留 GB2312 常用中文、拉丁字母、标点和当前 src 中出现的字符，保留 100–900 可变字重，移除 hinting 并压缩为 WOFF2。未包含的生僻字回退到设备的无衬线字体。生成文件约 1.87 MiB，由 next/font/local 同源发布及预加载；浏览器和构建无需连接 Google 字体服务。

再生成需要 Python 的 fonttools 和 brotli，运行：

    python scripts/subset-font.py <NotoSansSC-VF.ttf> src/app/fonts/livenest-sans-sc.woff2

字体工具只用于维护者再生成，不是应用运行或正常构建依赖。
