/**
 * 审计与自检面板。
 *
 * 上半部分是「现在到底像不像配置里那台机器」——自检结果来自主进程在页面里跑的真实探测；
 * 下半部分是「过去发生了什么」——哈希链只追加，可随时重算校验。
 * 两者放同一页，是因为自检本身也会写一条审计记录：跑一次自检就能看到链在增长。
 *
 * 归属：audit-agent
 * 样式只写同目录 audit.css，不动全局样式，避免并行开发时互相覆盖。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  AuditEntry,
  AuditVerifyResult,
  CheckSeverity,
  ConsistencyReport,
  Profile
} from '@shared/types'
import { Button, cx, useToast } from '@renderer/components/ui'
import { formatClock, formatDate } from '@renderer/lib/format'
import './audit.css'

export interface PanelProps {
  profiles: Profile[]
}

const SEVERITY_TEXT: Record<CheckSeverity, string> = {
  pass: '通过',
  warn: '注意',
  fail: '失败'
}

/** 90 分以上说明这套参数自洽；70 以下基本会被风控当成拼装环境 */
function scoreTone(score: number): 'ok' | 'warn' | 'bad' {
  if (score >= 90) return 'ok'
  if (score >= 70) return 'warn'
  return 'bad'
}

function readError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function AuditPanel({ profiles }: PanelProps) {
  const toast = useToast()
  const [profileId, setProfileId] = useState<string>(profiles[0]?.id ?? '')
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<ConsistencyReport | null>(null)
  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [loadingLog, setLoadingLog] = useState(true)
  const [verifying, setVerifying] = useState(false)
  const [verdict, setVerdict] = useState<AuditVerifyResult | null>(null)

  // 环境列表是异步来的：首帧可能还是空的，等它到了再补一个默认选中
  useEffect(() => {
    if (profileId && profiles.some((p) => p.id === profileId)) return
    setProfileId(profiles[0]?.id ?? '')
  }, [profiles, profileId])

  const refreshLog = useCallback(async (): Promise<void> => {
    try {
      setEntries(await window.ss.audit.list(200))
    } catch (err) {
      toast.push(readError(err), 'err')
    } finally {
      setLoadingLog(false)
    }
  }, [toast])

  useEffect(() => {
    void refreshLog()
  }, [refreshLog])

  const active = profiles.find((p) => p.id === profileId) ?? null

  const summary = useMemo(() => {
    if (!report) return null
    const pass = report.items.filter((i) => i.severity === 'pass').length
    const warn = report.items.filter((i) => i.severity === 'warn').length
    const fail = report.items.filter((i) => i.severity === 'fail').length
    return { pass, warn, fail, total: report.items.length }
  }, [report])

  async function runCheck(): Promise<void> {
    if (!profileId) {
      toast.push('请先选择一个环境', 'info')
      return
    }
    setRunning(true)
    try {
      const next = await window.ss.selfcheck.run(profileId)
      setReport(next)
      // 自检会往链里追加一条，旧的校验结论立刻失效
      setVerdict(null)
      await refreshLog()
    } catch (err) {
      toast.push(readError(err), 'err')
    } finally {
      setRunning(false)
    }
  }

  async function runVerify(): Promise<void> {
    setVerifying(true)
    try {
      setVerdict(await window.ss.audit.verify())
    } catch (err) {
      toast.push(readError(err), 'err')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="au">
      <div className="page-head">
        <div>
          <h2>审计与自检</h2>
          <p>在真实页面里核对指纹，并按哈希链校验每一条操作记录</p>
        </div>
      </div>

      <section className="au-sec">
        <div className="au-head">
          <div className="au-title">
            <h3>指纹一致性自检</h3>
            <span>对照环境配置与页面实际读数，逐项给结论</span>
          </div>
          <div className="au-pick">
            <select
              className="au-select"
              value={profileId}
              disabled={profiles.length === 0 || running}
              onChange={(e) => setProfileId(e.target.value)}
              aria-label="选择要自检的环境"
            >
              {profiles.length === 0 ? <option value="">暂无环境</option> : null}
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.status === 'running' ? '（运行中）' : ''}
                </option>
              ))}
            </select>
            <Button
              variant="primary"
              icon="shield"
              disabled={running || !profileId}
              onClick={() => void runCheck()}
            >
              {running ? '自检中…' : '开始自检'}
            </Button>
          </div>
        </div>

        {active && active.status !== 'running' ? (
          <p className="au-note">
            自检需要读取页面内的真实值，请先打开 <b>{active.name}</b> 的窗口再开始。
          </p>
        ) : null}

        {report && summary ? (
          <>
            <div className="au-score">
              <div className={cx('au-score-v', scoreTone(report.score))}>
                {report.score}
                <small>分</small>
              </div>
              <div className="au-score-meta">
                <div className="au-score-t">
                  {report.profileName}
                  <span className={cx('au-pill', scoreTone(report.score))}>
                    {report.score >= 90 ? '参数自洽' : report.score >= 70 ? '存在疑点' : '容易被识破'}
                  </span>
                </div>
                <div className="au-score-d">
                  {formatDate(report.checkedAt)} {formatClock(report.checkedAt)} · 通过 {summary.pass} · 注意{' '}
                  {summary.warn} · 失败 {summary.fail} · 共 {summary.total} 项
                </div>
              </div>
            </div>

            <div className="au-table au-check">
              <div className="au-tr au-th">
                <span>检查项</span>
                <span>期望</span>
                <span>实际</span>
                <span>结果</span>
              </div>
              {report.items.map((i) => (
                <div key={i.key} className={cx('au-tr', i.severity)}>
                  <span className="au-k">
                    <b>{i.label}</b>
                    {i.hint ? <em>{i.hint}</em> : null}
                  </span>
                  <span className="au-mono" title={i.expected}>
                    {i.expected}
                  </span>
                  <span className="au-mono" title={i.actual}>
                    {i.actual}
                  </span>
                  <span className={cx('au-tag', i.severity)}>{SEVERITY_TEXT[i.severity]}</span>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="au-empty">
            <b>还没有自检结果</b>
            <p>
              选中一个已打开的环境并开始自检，会逐项比对 UA、时区、屏幕、WebGL、WebRTC、字体等读数，
              给出这套指纹是否自洽的分数。
            </p>
          </div>
        )}
      </section>

      <section className="au-sec">
        <div className="au-head">
          <div className="au-title">
            <h3>审计日志</h3>
            <span>每条记录携带上一条的哈希，只追加不可改</span>
          </div>
          <div className="au-pick">
            {verdict ? (
              <span className={cx('au-verdict', verdict.ok ? 'ok' : 'bad')} title={verdict.message}>
                {verdict.ok ? `链完整 · ${verdict.total} 条` : `断在第 ${verdict.brokenAt ?? '?'} 条`}
              </span>
            ) : null}
            <Button
              variant="ghost"
              icon="lock"
              disabled={verifying}
              onClick={() => void runVerify()}
            >
              {verifying ? '校验中…' : '验证完整性'}
            </Button>
          </div>
        </div>

        {verdict && !verdict.ok ? <p className="au-note bad">{verdict.message}</p> : null}

        {loadingLog ? (
          <div className="au-empty">
            <b>正在读取审计记录…</b>
          </div>
        ) : entries.length === 0 ? (
          <div className="au-empty">
            <b>还没有审计记录</b>
            <p>
              打开环境后跑一次自检，或者对环境做任何改动，操作都会按时间顺序追加到这里。
              每条记录的哈希包含上一条的哈希，事后删改任何一条都会被「验证完整性」发现。
            </p>
          </div>
        ) : (
          <>
            <div className="au-table au-log">
              <div className="au-tr au-th">
                <span>时间</span>
                <span>动作</span>
                <span>目标</span>
                <span>哈希</span>
              </div>
              {entries.map((e) => (
                <div key={e.id} className="au-tr">
                  <span className="au-mono au-time">
                    {formatDate(e.at)} {formatClock(e.at)}
                  </span>
                  <span className="au-act">{e.action}</span>
                  <span className="au-target" title={e.detail ?? e.target ?? ''}>
                    {e.target ?? '—'}
                    {e.detail ? <em>{e.detail}</em> : null}
                  </span>
                  <span className="au-mono au-hash" title={`${e.hash}\nprev ${e.prev}`}>
                    {e.hash.slice(0, 8)}
                    <i>#{e.seq}</i>
                  </span>
                </div>
              ))}
            </div>
            <p className="au-foot">
              列表只取最近 {entries.length} 条；哈希显示前 8 位，悬停可看完整值与上一条哈希。
            </p>
          </>
        )}
      </section>
    </div>
  )
}
