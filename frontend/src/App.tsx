import { useEffect } from 'react'
import { useStore } from './store'
import LoginView from './views/LoginView'
import MainLayout from './components/MainLayout'
import Toast from './components/Toast'
import './App.css'

function App() {
  const { isAuthenticated, initialize } = useStore()

  useEffect(() => {
    initialize()
  }, [initialize])

  return (
    <>
      {!isAuthenticated ? <LoginView /> : <MainLayout />}
      <Toast />
    </>
  )
}

export default App
