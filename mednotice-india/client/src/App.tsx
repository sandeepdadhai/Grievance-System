import type { ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { useAuth } from "./auth";
import { PublicLayout } from "./components/Layout";
import { LoadingPage } from "./components/ui";
import Home from "./pages/Home";
import Login from "./pages/Login";
import Signup from "./pages/Signup";
import Community from "./pages/Community";
import CommunityPostDetail from "./pages/CommunityPost";
import Submit from "./pages/Submit";
import Track from "./pages/Track";
import Portal from "./pages/Portal";
import CaseDetail from "./pages/CaseDetail";

/**
 * Patient application. The staff console is a separate bundle on its own origin
 * (client/admin.html → server/admin.ts), so no console page, navigation entry or
 * copy is part of what a patient downloads.
 */
function Protected({ roles, children }: { roles?: string[]; children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingPage />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (roles && !roles.includes(user.baseRole)) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<Home />} />
        <Route path="submit" element={<Submit />} />
        <Route path="track" element={<Track />} />
        <Route path="community" element={<Community />} />
        <Route path="community/:id" element={<CommunityPostDetail />} />
        <Route path="login" element={<Login />} />
        <Route path="signup" element={<Signup />} />
        <Route
          path="portal"
          element={
            <Protected roles={["PATIENT"]}>
              <Portal />
            </Protected>
          }
        />
        <Route
          path="cases/:id"
          element={
            <Protected>
              <CaseDetail />
            </Protected>
          }
        />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
