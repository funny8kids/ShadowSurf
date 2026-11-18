/**
 * 渲染层入口。
 *
 * 只做挂载，不做数据加载——数据流全部在 App 的 useEffect 里，
 * 这样 StrictMode 的双次挂载不会产生重复的业务副作用（订阅都有 cleanup）。
 */

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { I18nProvider } from './lib/i18n'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import './styles/visual-polish.css'
import './styles/density.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('找不到 #root 挂载点')
}

createRoot(container).render(
  <StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </StrictMode>
)
