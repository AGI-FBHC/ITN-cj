import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react"
import { useTheme } from "next-themes"
import { Toaster as Sonner, type ToasterProps } from "sonner"

const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()
  const infoColors = theme === "dark"
    ? {
        "--info-bg": "hsl(216, 60%, 10%)",
        "--info-border": "hsl(216, 45%, 24%)",
        "--info-text": "hsl(216, 92%, 78%)",
      }
    : {
        "--info-bg": "hsl(210, 100%, 97.5%)",
        "--info-border": "hsl(210, 80%, 86%)",
        "--info-text": "#174A7C",
      }

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
          ...infoColors,
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
