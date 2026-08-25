import { BrowserRouter, Route, Routes } from 'react-router-dom'
import StaffDashboard from './pages/StaffDashboard'
import PatientPage from './pages/PatientPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/staff/:slug" element={<StaffDashboard />} />
        <Route path="/q/:slug/:tokenId" element={<PatientPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
