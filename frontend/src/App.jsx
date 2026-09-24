import { lazy, Suspense } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import PatientPage from './pages/PatientPage'
import BoardPage from './pages/BoardPage'
import NotFoundPage from './pages/NotFoundPage'

// The public pages ship in the main bundle, since they are what phones open
// from a QR code or a WhatsApp link. The staff pages load on first visit, all
// from one chunk: the import is shared, so it is fetched once.
const loadStaffPages = () => import('./pages/staff')
const staffPage = (name) =>
  lazy(() => loadStaffPages().then((pages) => ({ default: pages[name] })))

const RequireStaff = staffPage('RequireStaff')
const StaffDashboard = staffPage('StaffDashboard')
const ReportPage = staffPage('ReportPage')
const FollowUpsPage = staffPage('FollowUpsPage')

// Matches the auth gate's own first screen, so the chunk arriving and the
// session check that follows it read as one step.
const staffLoading = (
  <main className="login-page">
    <p className="empty-state">Checking your session...</p>
  </main>
)

function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={staffLoading}>
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
      </Suspense>
    </BrowserRouter>
  )
}

export default App
