import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";

/**
 * Clerk's middleware runs only when Clerk is configured. Without keys
 * (local development, CI, the demo) every request passes straight through.
 */
const clerkEnabled = Boolean(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
const clerk = clerkEnabled ? clerkMiddleware() : null;

export default function middleware(req: NextRequest, event: NextFetchEvent) {
  return clerk ? clerk(req, event) : NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"],
};
