import { useEffect } from 'react'
import { useStore } from './store'
import LoginView from './views/LoginView'
import MainLayout from './components/MainLayout'
import Toast from './components/Toast'
import { startRouter } from './router'
import { loadCompanyTheme, loadUserTheme } from './theme/sync'
import './App.css'

function App() {
  const { isAuthenticated, initialize, menusLoaded } = useStore()

  useEffect(() => {
    void loadCompanyTheme()
    initialize()
  }, [initialize])

  useEffect(() => {
    if (isAuthenticated) void loadUserTheme()
  }, [isAuthenticated])

  // 登录且菜单就绪后按地址恢复页面（/report/xxx 需要菜单信息），并开始与浏览器历史同步
  useEffect(() => {
    if (isAuthenticated && menusLoaded) startRouter(useStore)
  }, [isAuthenticated, menusLoaded])

  return (
    <>
      {!isAuthenticated ? <LoginView /> : <MainLayout />}
      <Toast />
    </>
  )
}

export default App
