/** 公开历史版本下载列表，分页失败保留已有记录并提供同页重试。 */
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicRelease } from "@/server/releases";
/** 版本均来自公开发行资产，不把未发布的源码版本列为可下载。 */
export default function ReleaseHistory() {
  const [rows, setRows] = useState<PublicRelease[]>([]); const [next, setNext] = useState(1);
  const [more, setMore] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const reading = useRef(false);
  const load = useCallback(async (page: number) => {
    if (reading.current) return; reading.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/releases?page=" + page, { signal: AbortSignal.timeout(15_000) }); if (!response.ok) throw new Error();
      const result: { releases: PublicRelease[]; hasMore: boolean } = await response.json();
      setRows(old => [...old, ...result.releases.filter(r => !old.some(o => o.version === r.version))]); setMore(result.hasMore); setNext(page + 1);
    } catch { setError("历史版本暂未读取，请重试；也可查看官方发行记录。"); }
    finally { reading.current = false; setBusy(false); }
  }, []);
  useEffect(() => { const first = setTimeout(() => void load(1), 0); return () => clearTimeout(first); }, [load]);
  return <section className="download-history" aria-labelledby="history-title"><div className="download-history-heading"><h2 id="history-title">历史版本</h2><a href="https://github.com/Doris619619/LiveNest-Releases/releases" target="_blank" rel="noreferrer">官方发行记录 ↗</a></div>
    <p>需要指定版本时可在这里下载。日常使用建议选择上方最新版。</p>
    <ul>{rows.map(row => <li key={row.version}><div><strong>LiveNest {row.version}</strong><p><time dateTime={row.publishedAt}>{row.publishedAt.slice(0, 10)}</time> · Windows x64 · {(row.size / 1024 / 1024).toFixed(0)} MB</p></div><a href={row.notes} target="_blank" rel="noreferrer" aria-label={"查看 " + row.version + " 发行记录"}>发行记录</a><a className="download-version-link" href={row.download}>下载 {row.version} ↓</a></li>)}</ul>
    {error && <p role="status">{error}</p>}{!busy && !error && !rows.length && <p>暂时没有可下载的历史安装包。</p>}
    {(more || error) && <button disabled={busy} onClick={() => void load(next)}>{busy ? "正在读取…" : error ? "重新读取历史版本" : "加载更多版本"}</button>}
  </section>;
}
