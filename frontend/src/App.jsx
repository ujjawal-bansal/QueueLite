import { BrowserRouter, Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import StaffDashboard from './pages/StaffDashboard'
import ReportPage from './pages/ReportPage'
import FollowUpsPage from './pages/FollowUpsPage'
import PatientPage from './pages/PatientPage'
import BoardPage from './pages/BoardPage'
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
        <Route
          path="/staff/:slug/today"
          element={
            <RequireStaff>
              <ReportPage />
            </RequireStaff>
          }
        />
        <Route
          path="/staff/:slug/follow-ups"
          element={
            <RequireStaff>
              <FollowUpsPage />
            </RequireStaff>
          }
        />
        <Route path="/q/:slug/:tokenId" element={<PatientPage />} />
        <Route path="/board/:slug" element={<BoardPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}

export default App
