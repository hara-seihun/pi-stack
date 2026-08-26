package dev.piremote;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class SystemPromptSections {
    static final class Section {
        final String key;
        final String label;
        final String text;

        Section(String key, String label, String text) {
            this.key = key;
            this.label = label;
            this.text = text;
        }
    }

    private static final Pattern PROJECT_INSTRUCTIONS = Pattern.compile(
        "<project_instructions\\s+path=\"([^\"]+)\">\\s*([\\s\\S]*?)\\s*</project_instructions>");
    private static final Pattern SKILL = Pattern.compile("<skill>\\s*([\\s\\S]*?)\\s*</skill>");
    private static final Pattern SKILL_NAME = Pattern.compile("<name>\\s*([\\s\\S]*?)\\s*</name>");
    private static final Pattern SKILL_DESCRIPTION = Pattern.compile("<description>\\s*([\\s\\S]*?)\\s*</description>");
    private static final Pattern SKILL_LOCATION = Pattern.compile("<location>\\s*([\\s\\S]*?)\\s*</location>");

    private SystemPromptSections() {}

    static List<Section> split(String value) {
        String prompt = value == null ? "" : value;
        List<Section> sections = new ArrayList<>();

        int projectStart = prompt.indexOf("<project_context>");
        int projectEnd = prompt.indexOf("</project_context>", Math.max(0, projectStart));
        int projectAfter = projectEnd < 0 ? -1 : projectEnd + "</project_context>".length();
        int skillsStart = prompt.indexOf("<available_skills>");
        int skillsEnd = prompt.indexOf("</available_skills>", Math.max(0, skillsStart));
        int skillsAfter = skillsEnd < 0 ? -1 : skillsEnd + "</available_skills>".length();

        int firstStructured = firstPositive(projectStart, skillsStart);
        String system = firstStructured < 0 ? prompt : prompt.substring(0, firstStructured);
        add(sections, "system", "System · Pi", system);

        if (projectStart >= 0 && projectEnd >= projectStart) {
            String project = prompt.substring(projectStart, projectAfter);
            Matcher matcher = PROJECT_INSTRUCTIONS.matcher(project);
            int index = 0;
            while (matcher.find()) {
                String path = matcher.group(1).trim();
                add(sections, "instructions:" + index + ":" + path, instructionLabel(path), matcher.group(2));
                index++;
            }
            if (index == 0) add(sections, "project-context", "Project context", project);
        }

        if (skillsStart >= 0 && skillsEnd >= skillsStart) {
            if (projectAfter >= 0 && projectAfter < skillsStart)
                add(sections, "skills-instructions", "Skills", prompt.substring(projectAfter, skillsStart));

            String skills = prompt.substring(skillsStart, skillsAfter);
            Matcher matcher = SKILL.matcher(skills);
            int index = 0;
            while (matcher.find()) {
                String skill = matcher.group(1);
                String name = match(SKILL_NAME, skill, "skill");
                String description = match(SKILL_DESCRIPTION, skill, "");
                String location = match(SKILL_LOCATION, skill, "");
                StringBuilder text = new StringBuilder(description);
                if (!location.isBlank()) {
                    if (text.length() > 0) text.append("\n\n");
                    text.append("Location: `").append(location).append('`');
                }
                add(sections, "skill:" + index + ":" + name, "Skill · " + name, text.toString());
                index++;
            }
            if (index == 0) add(sections, "skills", "Available skills", skills);
        }

        int tailStart = skillsAfter >= 0 ? skillsAfter : projectAfter >= 0 ? projectAfter : firstStructured < 0 ? prompt.length() : firstStructured;
        if (tailStart < prompt.length()) add(sections, "session", "Session", prompt.substring(tailStart));

        if (sections.isEmpty()) add(sections, "system", "System · Pi", prompt);
        return sections;
    }

    private static int firstPositive(int first, int second) {
        if (first < 0) return second;
        if (second < 0) return first;
        return Math.min(first, second);
    }

    private static String instructionLabel(String value) {
        try {
            Path path = Paths.get(value);
            Path file = path.getFileName();
            Path parent = path.getParent();
            if (file != null && parent != null) return file + " · " + parent;
        } catch (RuntimeException ignored) {}
        return value.isBlank() ? "Project instructions" : value;
    }

    private static String match(Pattern pattern, String value, String fallback) {
        Matcher matcher = pattern.matcher(value);
        return matcher.find() ? matcher.group(1).trim() : fallback;
    }

    private static void add(List<Section> sections, String key, String label, String text) {
        String body = text == null ? "" : text.trim();
        if (!body.isEmpty()) sections.add(new Section(key, label, body));
    }
}
