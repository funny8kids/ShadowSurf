/**
 * 首次上手引导。
 *
 * 为什么需要：新用户打开应用看到的是「0 个环境 + 4 张零统计卡 + 一个空列表」。
 * 商业产品（Multilogin / AdsPower / GoLogin）都有 Getting Started：先建环境 →
 * 再配代理 → 最后打开窗口。这里做的是同一件事的本地版：不弹窗、不阻断，
 * 在控制台顶部给一张可折叠的引导卡，点一步进一步。
 *
 * 设计原则（与 DESIGN.md 一致）：
 * - 只在本机还没有环境时出现（不是「用户没点过」—— 那是另一个概念）；
 * - 每一步都能直接点，不要求先读文档；
 * - 关掉后不再出现（localStorage 记一个键），但设置里可以重新打开。
 */

import { useState } from 'react'
import type { Profile } from '@shared/types'
import { Button, Icon } from '@renderer/components/ui'
import { useI18n } from '@renderer/lib/i18n'

const DISMISS_KEY = 'ss:onboarded'

interface Props {
  profiles: Profile[]
  onCreate: () => void
  onOpenSettings: () => void
  onOpenDocs: () => void
}

export function OnboardingCard({ profiles, onCreate, onOpenSettings, onOpenDocs }: Props) {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      return false
    }
  })

  // 已经有环境了就不显示（不管有没有点过关闭）
  if (dismissed || profiles.length > 0) return null

  const dismiss = (): void => {
    setDismissed(true)
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* 隐私模式：这次会话不再显示即可 */
    }
  }

  return (
    <section className="onboard" aria-label={t('onboard.title')}>
      <div className="onboard-head">
        <div className="onboard-mark">
          <Icon name="wave" size={16} strokeWidth={2.2} />
        </div>
        <div className="onboard-title">
          <b>{t('onboard.title')}</b>
          <span>{t('onboard.subtitle')}</span>
        </div>
        <Button size="sm" variant="ghost" icon="close" onClick={dismiss}>
          {t('onboard.dismiss')}
        </Button>
      </div>

      <ol className="onboard-steps">
        <li>
          <span className="os-num">1</span>
          <div className="os-body">
            <b>{t('onboard.step1.title')}</b>
            <p>{t('onboard.step1.desc')}</p>
            <Button size="sm" variant="primary" icon="plus" onClick={onCreate}>
              {t('onboard.step1.action')}
            </Button>
          </div>
        </li>
        <li>
          <span className="os-num">2</span>
          <div className="os-body">
            <b>{t('onboard.step2.title')}</b>
            <p>{t('onboard.step2.desc')}</p>
            <Button size="sm" variant="ghost" icon="settings" onClick={onOpenSettings}>
              {t('onboard.step2.action')}
            </Button>
          </div>
        </li>
        <li>
          <span className="os-num">3</span>
          <div className="os-body">
            <b>{t('onboard.step3.title')}</b>
            <p>{t('onboard.step3.desc')}</p>
            <Button size="sm" variant="ghost" icon="external" onClick={onOpenDocs}>
              {t('onboard.step3.action')}
            </Button>
          </div>
        </li>
      </ol>
    </section>
  )
}

/** 设置里「重新显示引导」用：清掉本机的已读标记 */
export function resetOnboarding(): void {
  try {
    localStorage.removeItem(DISMISS_KEY)
  } catch {
    /* 读不到就下次自然显示 */
  }
}