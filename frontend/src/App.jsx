import { BrowserRouter, Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import StaffDashboard from './pages/StaffDashboard'
import PatientPage from './pages/PatientPage'
import NotFoundPage from './pages/NotFoundPage'
import RequireStaff from './components/RequireStaff'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route
          path="/staff/:slug"
          element={
            <RequireStaff>
              <StaffDashboard />
            </RequireStaff>
          }
        />
        <Route path="/q/:slug/:tokenId" element={<PatientPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
