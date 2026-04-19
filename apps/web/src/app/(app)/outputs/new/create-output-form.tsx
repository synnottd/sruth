"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api/client";
import { useCreateOutput } from "@/lib/api/hooks";
import { useToast } from "@/components/toast";
import type { Platform } from "@/lib/api/types";

const PLATFORM_PRESETS: Record<Platform, string> = {
  TWITCH: "rtmp://live.twitch.tv/app",
  YOUTUBE: "rtmp://a.rtmp.youtube.com/live2",
  FACEBOOK: "rtmps://live-api-s.facebook.com:443/rtmp/",
  CUSTOM: "",
};

export function CreateOutputForm() {
  const router = useRouter();
  const createOutput = useCreateOutput();
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const [platform, setPlatform] = useState<Platform>("TWITCH");
  const [rtmpUrl, setRtmpUrl] = useState(PLATFORM_PRESETS.TWITCH);

  function handlePlatformChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value as Platform;
    setPlatform(value);
    setRtmpUrl(PLATFORM_PRESETS[value] ?? "");
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);

    const form = new FormData(e.currentTarget);
    const name = form.get("name") as string;
    const streamKey = form.get("streamKey") as string;

    try {
      await createOutput.mutateAsync({ name, platform, rtmpUrl, streamKey });
      toast("Output created");
      router.push("/outputs");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("Something went wrong");
      }
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-lg space-y-4">
      <div className="space-y-1">
        <label htmlFor="name" className="block text-sm font-medium">
          Name
        </label>
        <input
          id="name"
          name="name"
          type="text"
          required
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-white focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="platform" className="block text-sm font-medium">
          Platform
        </label>
        <select
          id="platform"
          value={platform}
          onChange={handlePlatformChange}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-white focus:outline-none"
        >
          <option value="TWITCH">Twitch</option>
          <option value="YOUTUBE">YouTube</option>
          <option value="FACEBOOK">Facebook</option>
          <option value="CUSTOM">Custom</option>
        </select>
      </div>

      <div className="space-y-1">
        <label htmlFor="rtmpUrl" className="block text-sm font-medium">
          RTMP URL
        </label>
        <input
          id="rtmpUrl"
          name="rtmpUrl"
          type="text"
          required
          value={rtmpUrl}
          onChange={(e) => setRtmpUrl(e.target.value)}
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-white focus:outline-none"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="streamKey" className="block text-sm font-medium">
          Stream Key
        </label>
        <input
          id="streamKey"
          name="streamKey"
          type="password"
          required
          className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm focus:border-white focus:outline-none"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        className="rounded-md bg-white px-4 py-2 text-sm font-medium text-black hover:bg-zinc-200"
      >
        Create output
      </button>
    </form>
  );
}
