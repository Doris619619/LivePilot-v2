/** 可搜索发布时区下拉框：明确选择生效，支持方向键、回车、Escape 和手机触摸。 */
"use client";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { filterTimezones, timezoneOption, timezoneOptions, validTimezone } from "./timezone-options";
import styles from "./timezone-select.module.css";
type Props = { value: string; date: string; change(value: string): void; disabled?: boolean };
/** 搜索文字与已保存时区分开；未点击选项不会把不完整输入写入发布计划。 */
export default function TimezoneSelect({ value, date, change, disabled = false }: Props) {
  const id = useId(); const trigger = useRef<HTMLButtonElement>(null); const search = useRef<HTMLInputElement>(null); const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false); const [query, setQuery] = useState(""); const [active, setActive] = useState(0);
  const options = useMemo(() => timezoneOptions(value, date), [value, date]);
  const matches = useMemo(() => filterTimezones(options, query, date), [options, query, date]);
  const visible = matches.slice(0, 50); const selected = validTimezone(value) ? timezoneOption(value, date) : { city: "请选择时区", offset: "" };
  useEffect(() => { if (open) search.current?.focus(); }, [open]);
  useEffect(() => { if (open) list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" }); }, [open, active, query]);
  /** 明确选择才更新父表单，关闭后把键盘焦点还给原控件。 */
  function choose(zone: string) { change(zone); setOpen(false); setQuery(""); trigger.current?.focus(); }
  /** 开启时展示当前值及常用城市；方向键可从关闭状态直接进入搜索。 */
  function show() { setQuery(""); setActive(0); setOpen(true); }
  /** 回车只选择时区，不提交所在发布表单；Escape 不改变已保存选择。 */
  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setActive(index => Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))); }
    else if (event.key === "Enter") { event.preventDefault(); if (visible[active]) choose(visible[active].value); }
  }
  return <div className={styles.control} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => { if (event.key === "Escape" && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); } }}>
    <label id={id + "-label"} htmlFor={id}>时区</label>
    <button ref={trigger} id={id} type="button" className={styles.trigger} disabled={disabled} aria-labelledby={id + "-label"} aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id + "-list" : undefined} onClick={() => open ? setOpen(false) : show()} onKeyDown={event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); show(); } }}>
      <span><strong>{selected.city}{selected.offset && " · " + selected.offset}</strong><small>{value}</small></span><span aria-hidden="true">⌄</span>
    </button>
    {open && <div className={styles.menu}>
      <input ref={search} role="combobox" aria-label="搜索时区" aria-autocomplete="list" aria-expanded="true" aria-controls={id + "-list"} aria-activedescendant={visible[active] ? id + "-option-" + active : undefined} autoComplete="off" placeholder="城市、时区或 UTC 偏移" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={navigate} />
      <div ref={list} id={id + "-list"} className={styles.options} role="listbox" aria-labelledby={id + "-label"}>
        {visible.map((option, index) => <button key={option.value} id={id + "-option-" + index} type="button" role="option" aria-selected={option.value === value} data-active={index === active} className={index === active ? styles.active : ""} onClick={() => choose(option.value)}><span>{option.city} · {option.offset}</span><small>{option.value}</small></button>)}
        {!visible.length && <p className={styles.empty} role="status">没有匹配时区，请换个城市或 IANA 名称。</p>}
      </div>
      {matches.length > visible.length && <p className={styles.hint}>输入城市或名称，搜索全部时区。</p>}
    </div>}
  </div>;
}
