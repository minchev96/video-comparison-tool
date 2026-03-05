import { Navigate, Route, Routes } from 'react-router-dom'
import MainComparePage from './pages/MainComparePage.jsx'
import LiveComparePage from './pages/LiveComparePage.jsx'

function App() {
  return (
    <Routes>
      <Route path="/" element={<MainComparePage />} />
      <Route path="/live" element={<LiveComparePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App
