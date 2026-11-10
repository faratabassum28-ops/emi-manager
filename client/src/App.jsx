import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Layout from './pages/Layout';
import Login from './pages/Login';
import Home from './pages/Home';
import ProgramPage from './pages/ProgramPage';
import NewEnrollment from './pages/NewEnrollment';
import EnrollmentProfile from './pages/EnrollmentProfile';
import TrackerPage from './pages/TrackerPage';
import VerifyPage from './pages/VerifyPage';
import Settings from './pages/Settings';
import ImportPage from './pages/ImportPage';
import ActivityPage from './pages/ActivityPage';
import { Loading } from './components/ui';

export default function App() {
  const { user, ready } = useAuth();
  if (!ready) return <Loading />;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="p/:programId/:batchId/enroll" element={<NewEnrollment />} />
        <Route path="p/:programId/:batchId?/:tab?" element={<ProgramPage />} />
        <Route path="enrollments/:id" element={<EnrollmentProfile />} />
        <Route path="tracker" element={<TrackerPage />} />
        <Route path="verify" element={<VerifyPage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
