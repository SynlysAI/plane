"""Repair historical Synlora delegated-subject account aliases."""

from django.core.management.base import BaseCommand

from plane.research.services.agent_identity import repair_synlora_account_links


class Command(BaseCommand):
    """Submit verified Plane/Synlora bindings to Synlora's idempotent repair API."""

    help = "Alias historical Plane delegated sessions to verified Synlora users"

    def add_arguments(self, parser):
        """Add the operational dry-run switch."""

        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        """Run the repair and print a compact count summary."""

        result = repair_synlora_account_links(dry_run=bool(options["dry_run"]))
        self.stdout.write(", ".join(f"{key}={value}" for key, value in result.items()))
