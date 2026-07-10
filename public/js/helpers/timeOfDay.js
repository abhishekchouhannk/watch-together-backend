const VALID_THEMES = ["morning", "afternoon", "evening", "night"];

export function getTimeOfDay() {
    const override = new URLSearchParams(window.location.search).get("theme");

    if (override && VALID_THEMES.includes(override))
        return override;

    const h = new Date().getHours();

    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 20) return "evening";
    return "night";
}