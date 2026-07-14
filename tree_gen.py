#!/usr/bin/env python3
"""
Universal Smart Tree Generator
Generates a clean, logic-focused directory tree for any project.
Optimized for issue-fixing by hiding noise while preserving structural context.
"""

import os
import argparse
from pathlib import Path
from typing import Set, List


class TreeGenerator:
    # Universal configuration for most modern software projects
    DEFAULT_CONFIG = {
        'exclude_dirs': [
            # Common Build & Environment
            'node_modules', '__pycache__', '.git', '.vscode', '.idea',
            'venv', '.venv', 'env', 'dist', 'build', 'target', '.next', 'coverage',
            '.pytest_cache', '.mypy_cache', '.github', '.gradle', '.kotlin',
            
            # Common Assets & UI (usually non-logic)
            'img', 'images', 'assets', 'fonts', 'static', 'public',
            'css', 'less', 'scss', 'sass', 'webapp/css', 'webapp/fonts',
            
            # Project-specific non-logic (MoPat & similar)
            'selenium', 'examples', 'fhir-dstu3-xsd', 'message/language',
            'webapp/jQuery', 'webapp/wysiwyg'
        ],
        'exclude_files': [
            # System & Lock files
            '.DS_Store', 'Thumbs.db', '.gitignore', 'package-lock.json',
            'yarn.lock', 'pnpm-lock.yaml', '.env',
            
            # Meta & Docs
            'LICENSE', 'README.md', 'CONTRIBUTING.md', 'CHANGELOG.md'
        ],
        'exclude_patterns': [
            # Compiled binaries
            '.class', '.pyc', '.pyo', '.exe', '.dll', '.so',
            
            # Images & Fonts
            '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.psd',
            '.woff', '.woff2', '.eot', '.ttf', '.otf',
            
            # Style & UI
            '.less', '.css', '.scss', '.sass',
            
            # Data & Config (Optional: can be toggled)
            '.log', '.properties', '.xsd', '.ignore'
        ],
        'include_extensions': None,
        'max_depth': None,
        'prune_empty': True  # Hide folders that only contain excluded items
    }

    def __init__(self, config: dict = None):
        """Initialize with configuration"""
        self.config = {**self.DEFAULT_CONFIG, **(config or {})}
        self.exclude_dirs = set(self.config['exclude_dirs'])
        self.exclude_files = set(self.config['exclude_files'])
        self.exclude_patterns = self.config['exclude_patterns']
        self.include_extensions = self.config['include_extensions']
        self.max_depth = self.config['max_depth']
        self.prune_empty = self.config['prune_empty']

    def _should_exclude(self, path: Path) -> bool:
        """Check if path should be excluded based on config"""
        if path.is_dir():
            return path.name in self.exclude_dirs
        else:
            if path.name in self.exclude_files:
                return True
            for pattern in self.exclude_patterns:
                if path.name.lower().endswith(pattern.lower()):
                    return True
            if self.include_extensions:
                return path.suffix not in self.include_extensions
        return False

    def _has_visible_children(self, path: Path) -> bool:
        """Recursively check if a directory has any non-excluded files"""
        try:
            for item in path.iterdir():
                if not self._should_exclude(item):
                    if item.is_dir():
                        if self._has_visible_children(item):
                            return True
                    else:
                        return True
            return False
        except PermissionError:
            return False

    def generate_tree(self, directory: str = ".", output_file: str = None) -> str:
        """Generate tree structure for directory"""
        root_path = Path(directory).resolve()
        if not root_path.exists():
            raise ValueError(f"Directory '{directory}' does not exist")

        tree_lines = [f"{root_path.name}/"]
        self._build_tree(root_path, "", tree_lines, depth=0)

        tree_output = "\n".join(tree_lines)
        if output_file:
            with open(output_file, 'w', encoding='utf-8') as f:
                f.write(tree_output)
            print(f"Tree structure saved to '{output_file}'")
        return tree_output

    def _build_tree(self, path: Path, prefix: str, lines: List[str], depth: int):
        """Recursively build tree structure"""
        if self.max_depth and depth >= self.max_depth:
            return

        try:
            # Filter contents
            items = [item for item in path.iterdir() if not self._should_exclude(item)]
            
            # Prune empty directories if enabled
            if self.prune_empty:
                filtered_contents = []
                for item in items:
                    if item.is_dir():
                        if self._has_visible_children(item):
                            filtered_contents.append(item)
                    else:
                        filtered_contents.append(item)
            else:
                filtered_contents = items

            # Sort: directories first, then files
            contents = sorted(filtered_contents, key=lambda p: (not p.is_dir(), p.name.lower()))
            
        except PermissionError:
            return

        for i, item in enumerate(contents):
            is_last = i == len(contents) - 1
            current_prefix = "└── " if is_last else "├── "
            next_prefix = "    " if is_last else "│   "

            display_name = item.name + "/" if item.is_dir() else item.name
            lines.append(f"{prefix}{current_prefix}{display_name}")

            if item.is_dir():
                self._build_tree(item, prefix + next_prefix, lines, depth + 1)


def main():
    """Main function to run the universal tree generator"""
    parser = argparse.ArgumentParser(
        description='Universal Smart Tree Generator for clean project visualization',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )

    parser.add_argument('directory', nargs='?', default='.',
                        help='Directory to generate tree for (default: current directory)')
    parser.add_argument('-o', '--output', help='Output file (default: print to console)')
    parser.add_argument('--max-depth', type=int, help='Maximum depth to traverse')
    parser.add_argument('--ext', nargs='+', help='Include only these extensions (e.g., .java .py)')
    parser.add_argument('--all', action='store_true', help='Show all files (disable pruning and common exclusions)')

    args = parser.parse_args()

    config = {}
    if args.max_depth:
        config['max_depth'] = args.max_depth
    if args.ext:
        config['include_extensions'] = args.ext
    
    if args.all:
        config['exclude_dirs'] = ['.git']
        config['exclude_files'] = []
        config['exclude_patterns'] = []
        config['prune_empty'] = False

    generator = TreeGenerator(config=config)
    tree = generator.generate_tree(args.directory, args.output)

    if not args.output:
        print(tree)


if __name__ == "__main__":
    main()
