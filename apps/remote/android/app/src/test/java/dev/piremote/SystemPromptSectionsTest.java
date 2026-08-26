package dev.piremote;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public class SystemPromptSectionsTest {
    @Test public void separatesEveryAlwaysAppliedSection() {
        String prompt = "Pi base instructions\n\n"
            + "<project_context>\nProject-specific instructions:\n"
            + "<project_instructions path=\"/home/kenan/AGENTS.md\">\n# Home rules\n</project_instructions>\n"
            + "<project_instructions path=\"/home/kenan/project/AGENTS.md\">\n# Project rules\n</project_instructions>\n"
            + "</project_context>\n\nThe following skills are available.\n"
            + "<available_skills>\n<skill>\n<name>search</name>\n<description>Search the web.</description>\n"
            + "<location>/skills/search/SKILL.md</location>\n</skill>\n"
            + "<skill>\n<name>writing</name>\n<description>Edit prose.</description>\n"
            + "<location>/skills/writing/SKILL.md</location>\n</skill>\n</available_skills>\n"
            + "Current working directory: /home/kenan";

        List<SystemPromptSections.Section> sections = SystemPromptSections.split(prompt);

        assertEquals(List.of(
            "System · Pi",
            "AGENTS.md · /home/kenan",
            "AGENTS.md · /home/kenan/project",
            "Skills",
            "Skill · search",
            "Skill · writing",
            "Session"
        ), sections.stream().map(section -> section.label).toList());
        assertEquals("# Home rules", sections.get(1).text);
        assertEquals("Search the web.\n\nLocation: `/skills/search/SKILL.md`", sections.get(4).text);
        assertEquals("Current working directory: /home/kenan", sections.get(6).text);
    }

    @Test public void keepsAnUnstructuredPromptAsOneSystemRow() {
        List<SystemPromptSections.Section> sections = SystemPromptSections.split("One ordinary prompt");

        assertEquals(1, sections.size());
        assertEquals("System · Pi", sections.get(0).label);
        assertEquals("One ordinary prompt", sections.get(0).text);
    }

    @Test public void handlesSkillsWithoutProjectInstructionsWithoutDuplicatingTheSystemText() {
        List<SystemPromptSections.Section> sections = SystemPromptSections.split(
            "Base\n<available_skills><skill><name>read</name><description>Read.</description></skill></available_skills>\nTail");

        assertEquals(List.of("System · Pi", "Skill · read", "Session"),
            sections.stream().map(section -> section.label).toList());
        assertEquals("Base", sections.get(0).text);
    }
}
