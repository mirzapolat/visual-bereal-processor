import json
from datetime import datetime
from PIL import Image, ImageDraw, ImageOps, ExifTags
import logging
from pathlib import Path
import piexif
import os
import argparse
import time
import shutil
from iptcinfo3 import IPTCInfo

# ANSI escape codes for text styling
STYLING = {
    "GREEN": "\033[92m",
    "RED": "\033[91m",
    "BLUE": "\033[94m",
    "BOLD": "\033[1m",
    "RESET": "\033[0m",
}

def parse_args():
    parser = argparse.ArgumentParser(description="Process BeReal export photos.")
    parser.add_argument("--config", help="Path to JSON config file", default=None)
    parser.add_argument("--base-dir", help="Base directory containing posts.json and Photos", default=None)
    parser.add_argument("--non-interactive", action="store_true", help="Skip interactive prompts")
    return parser.parse_args()

args = parse_args()
config = {}
config_mode = args.non_interactive or args.config is not None
if args.config:
    try:
        with open(args.config, encoding="utf8") as config_file:
            config = json.load(config_file)
    except FileNotFoundError:
        logging.error("Config file not found. Please check the path.")
        exit()

#Setup log styling
class ColorFormatter(logging.Formatter):
    def format(self, record):
        message = super().format(record)
        if record.levelno == logging.INFO and "Finished processing" not in record.msg:
            message = STYLING["GREEN"] + message + STYLING["RESET"]
        elif record.levelno == logging.ERROR:
            message = STYLING["RED"] + message + STYLING["RESET"]
        elif "Finished processing" in record.msg:  # Identify the summary message
            message = STYLING["BLUE"] + STYLING["BOLD"] + message + STYLING["RESET"]
        return message

# Setup basic logging
# logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# Setup logging with styling
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger()
handler = logger.handlers[0]  # Get the default handler installed by basicConfig
handler.setFormatter(ColorFormatter('%(asctime)s - %(levelname)s - %(message)s'))

# Initialize counters
processed_files_count = 0
converted_files_count = 0
combined_files_count = 0
skipped_files_count = 0
skipped_entries_by_date_count = 0

# Static IPTC tags
source_app = "BeReal app"
processing_tool = "github/bereal-gdpr-photo-toolkit"
#keywords = ["BeReal"]

def configure_logging(verbose_logging):
    level = logging.INFO if verbose_logging == 'yes' else logging.WARNING
    logger.setLevel(level)
    for log_handler in logger.handlers:
        log_handler.setLevel(level)

# Define lists to hold the paths of images to be combined
primary_images = []
secondary_images = []
processed_output_paths = []

# Define paths using pathlib
base_dir = Path(args.base_dir or os.environ.get("BEREAL_BASE_DIR") or Path(__file__).resolve().parent)
photo_folder = base_dir / 'Photos/post/'
bereal_folder = base_dir / 'Photos/bereal'
output_folder = base_dir / 'Photos/post/__processed'
output_folder_combined = base_dir / 'Photos/post/__combined'
script_dir = base_dir
output_folder.mkdir(parents=True, exist_ok=True)  # Create the output folder if it doesn't exist

# Print the paths
startup_preamble_lines = [
    STYLING["BOLD"] + "\nThe following paths are set for the input and output files:" + STYLING["RESET"],
    f"Photo folder: {photo_folder}",
]
if os.path.exists(bereal_folder):
    startup_preamble_lines.append(f"Older photo folder: {bereal_folder}")
startup_preamble_lines.extend([
    f"Output folder for singular images (temporary): {output_folder}",
    f"Output folder for combined images (temporary): {output_folder_combined}",
    f"Final output location: {script_dir}",
    ""
])

# Function to count number of input files
def count_files_in_folder(folder_path):
    folder = Path(folder_path)
    file_count = len(list(folder.glob('*.webp')))
    return file_count

number_of_files = count_files_in_folder(photo_folder)
startup_preamble_lines.append(f"Number of WebP-files in {photo_folder}: {number_of_files}")

if os.path.exists(bereal_folder):
    number_of_files = count_files_in_folder(bereal_folder)
    startup_preamble_lines.append(f"Number of (older) WebP-files in {bereal_folder}: {number_of_files}")

startup_preamble = "\n".join(startup_preamble_lines)

# Settings
## Default responses
convert_to_jpeg = 'yes'
keep_original_filename = 'no'
create_combined_images = 'yes'
since_date = None
delete_processed_files_after_combining = 'yes'
use_verbose_logging = 'no'

def normalize_yes_no(value, default):
    if value is None:
        return default
    if isinstance(value, bool):
        return 'yes' if value else 'no'
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in ['yes', 'true', '1']:
            return 'yes'
        if normalized in ['no', 'false', '0']:
            return 'no'
    return default

def parse_since_date(value):
    if value in [None, "", "null"]:
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str):
        try:
            return datetime.strptime(value, "%Y-%m-%d").date()
        except ValueError:
            logging.error("Invalid since_date format in config. Expected YYYY-MM-DD.")
            return None
    return None

def apply_config(config_values):
    global convert_to_jpeg
    global keep_original_filename
    global create_combined_images
    global delete_processed_files_after_combining
    global use_verbose_logging
    global since_date

    convert_to_jpeg = normalize_yes_no(config_values.get('convert_to_jpeg'), convert_to_jpeg)
    keep_original_filename = normalize_yes_no(config_values.get('keep_original_filename'), keep_original_filename)
    create_combined_images = normalize_yes_no(config_values.get('create_combined_images'), create_combined_images)
    delete_processed_files_after_combining = normalize_yes_no(
        config_values.get('delete_processed_files_after_combining'),
        delete_processed_files_after_combining
    )
    use_verbose_logging = normalize_yes_no(config_values.get('use_verbose_logging'), use_verbose_logging)
    since_date = parse_since_date(config_values.get('since_date'))

if config_mode:
    apply_config(config)

def format_since_date(value):
    if value is None:
        return "all time"
    return value.strftime("%Y-%m-%d")

def format_output_style(verbose_logging):
    if verbose_logging == 'yes':
        return "extensive logs"
    return "progress bars"

def output_status(message):
    if use_verbose_logging == 'yes':
        print(message)

def render_progress(current, total, label):
    if total <= 0:
        return
    bar_length = 34
    label_width = 18
    count_width = len(str(total))
    filled_length = int(bar_length * current / total)
    if filled_length <= 0:
        bar = "." * bar_length
    elif filled_length >= bar_length:
        bar = "=" * bar_length
    else:
        bar = "=" * (filled_length - 1) + ">" + "." * (bar_length - filled_length)
    percent = int((current / total) * 100)
    label_text = f"{label:<{label_width}}"
    count_text = f"{current:>{count_width}}/{total}"
    print(f"\r{label_text} [{bar}] {count_text} ({percent:3d}%)", end="", flush=True)
    if current >= total:
        print("")

def output_summary(summary_text, verbose_logging):
    if verbose_logging == 'yes':
        logging.info(summary_text)
    else:
        print(STYLING["BLUE"] + STYLING["BOLD"] + summary_text + STYLING["RESET"])

print(startup_preamble)
print(STYLING["BOLD"] + "\nStartup settings (current values):" + STYLING["RESET"])
print(
    f"1. Convert images from WebP to JPEG (current: {convert_to_jpeg})\n"
    f"2. Keep original filename in renamed file (current: {keep_original_filename})\n"
    f"3. Create combined images like BeReal memories (current: {create_combined_images})\n"
    f"4. Start date filter (current: {format_since_date(since_date)})\n"
    f"5. Delete processed single files after combining (current: {delete_processed_files_after_combining})\n"
    f"6. Output style (current: {format_output_style(use_verbose_logging)})"
)

if config_mode:
    print(STYLING["BOLD"] + "\nUsing non-interactive config settings.\n" + STYLING["RESET"])
    selection_input = ""
else:
    selection_input = input("\nEnter a setting number to change or press Enter to continue: ").strip()
if selection_input == "":
    print("Continuing with selected settings.\n")
else:
    while True:
        if not selection_input.isdigit() or not 1 <= int(selection_input) <= 6:
            logging.error("Invalid selection. Enter a number between 1 and 6.")
            selection_input = input("Enter a setting number (1-6) or press Enter to continue: ").strip()
            if selection_input == "":
                print("Continuing with selected settings.\n")
                break
            continue

        selection = int(selection_input)

        if selection == 1:
            # User choice for converting to JPEG
            convert_to_jpeg = None
            while convert_to_jpeg not in ['yes', 'no']:
                convert_to_jpeg = input(STYLING["BOLD"] + "\n1. Do you want to convert images from WebP to JPEG? (yes/no): " + STYLING["RESET"]).strip().lower()
                if convert_to_jpeg == 'no':
                    print("Your images will not be converted. No additional metadata will be added.")
                if convert_to_jpeg not in ['yes', 'no']:
                    logging.error("Invalid input. Please enter 'yes' or 'no'.")

        if selection == 2:
            # User choice for keeping original filename
            print(STYLING["BOLD"] + "\n2. There are two options for how output files can be named" + STYLING["RESET"] + "\n"
            "Option 1: YYYY-MM-DDTHH-MM-SS_primary/secondary_original-filename.jpeg\n"
            "Option 2: YYYY-MM-DDTHH-MM-SS_primary/secondary.jpeg\n"
            "This will only influence the naming scheme of singular images.")
            keep_original_filename = None
            while keep_original_filename not in ['yes', 'no']:
                keep_original_filename = input(STYLING["BOLD"] + "Do you want to keep the original filename in the renamed file? (yes/no): " + STYLING["RESET"]).strip().lower()
                if keep_original_filename not in ['yes', 'no']:
                    logging.error("Invalid input. Please enter 'yes' or 'no'.")

        if selection == 3:
            # User choice for creating combined images
            create_combined_images = None
            while create_combined_images not in ['yes', 'no']:
                create_combined_images = input(STYLING["BOLD"] + "\n3. Do you want to create combined images like the original BeReal memories? (yes/no): " + STYLING["RESET"]).strip().lower()
                if create_combined_images not in ['yes', 'no']:
                    logging.error("Invalid input. Please enter 'yes' or 'no'.")

        if selection == 4:
            # User choice for date cutoff
            print(STYLING["BOLD"] + "\n4. Do you want to filter by a start date?" + STYLING["RESET"])
            while True:
                date_input = input("Enter a start date (YYYY-MM-DD) or press Enter for all time: ").strip()
                if date_input == "":
                    since_date = None
                    break
                try:
                    since_date = datetime.strptime(date_input, "%Y-%m-%d").date()
                    break
                except ValueError:
                    logging.error("Invalid date format. Please use YYYY-MM-DD or press Enter for all time.")

        if selection == 5:
            # User choice for deleting processed single files
            delete_processed_files_after_combining = None
            while delete_processed_files_after_combining not in ['yes', 'no']:
                delete_processed_files_after_combining = input(STYLING["BOLD"] + "\n5. Delete processed single files after combining? (yes/no) [default: yes]: " + STYLING["RESET"]).strip().lower()
                if delete_processed_files_after_combining == "":
                    delete_processed_files_after_combining = 'yes'
                if delete_processed_files_after_combining not in ['yes', 'no']:
                    logging.error("Invalid input. Please enter 'yes' or 'no'.")

        if selection == 6:
            # User choice for output style
            use_verbose_logging = None
            while use_verbose_logging not in ['yes', 'no']:
                use_verbose_logging = input(STYLING["BOLD"] + "\n6. Use extensive logs instead of progress bars? (yes/no) [default: no]: " + STYLING["RESET"]).strip().lower()
                if use_verbose_logging == "":
                    use_verbose_logging = 'no'
                if use_verbose_logging not in ['yes', 'no']:
                    logging.error("Invalid input. Please enter 'yes' or 'no'.")

        selection_input = input("\nChange another setting? Enter a number (1-6) or press Enter to start processing: ").strip()
        if selection_input == "":
            print("Continuing with selected settings.\n")
            break
        if not selection_input.isdigit() or not 1 <= int(selection_input) <= 6:
            logging.error("Invalid selection. Enter a number between 1 and 6 or press Enter to start processing.")
            selection_input = input("Enter a setting number (1-6) or press Enter to start processing: ").strip()
            if selection_input == "":
                print("Continuing with selected settings.\n")
                break

use_progress_bars = use_verbose_logging != 'yes'
configure_logging(use_verbose_logging)

if convert_to_jpeg == 'no' and create_combined_images == 'no':
    print("You chose not to convert images nor do you want to output combined images.\n"
    "The script will therefore only copy images to a new folder and rename them according to your choice without adding metadata or creating new files.\n"
    "Script will continue to run in 5 seconds.")
    #time.sleep(10)

# Function to convert WEBP to JPEG
def convert_webp_to_jpg(image_path):
    if image_path.suffix.lower() == '.webp':
        jpg_path = image_path.with_suffix('.jpg')
        try:
            with Image.open(image_path) as img:
                img.convert('RGB').save(jpg_path, "JPEG", quality=80)
                logging.info(f"Converted {image_path} to JPEG.")
            return jpg_path, True
        except Exception as e:
            logging.error(f"Error converting {image_path} to JPEG: {e}")
            return None, False
    else:
        return image_path, False

# Helper function to convert latitude and longitude to EXIF-friendly format
def _convert_to_degrees(value):
    """Convert decimal latitude / longitude to degrees, minutes, seconds (DMS)"""
    d = int(value)
    m = int((value - d) * 60)
    s = (value - d - m/60) * 3600.00

    # Convert to tuples of (numerator, denominator)
    d = (d, 1)
    m = (m, 1)
    s = (int(s * 100), 100)  # Assuming 2 decimal places for seconds for precision

    return (d, m, s)

# Function to update EXIF data
def update_exif(image_path, datetime_original, location=None, caption=None):
    try:
        exif_dict = piexif.load(image_path.as_posix())

        # Ensure the '0th' and 'Exif' directories are initialized
        if '0th' not in exif_dict:
            exif_dict['0th'] = {}
        if 'Exif' not in exif_dict:
            exif_dict['Exif'] = {}

        # For debugging: Load and log the updated EXIF data
        #logging.info(f"Original EXIF data for {image_path}: {exif_dict}")

        # Update datetime original
        exif_dict['Exif'][piexif.ExifIFD.DateTimeOriginal] = datetime_original.strftime("%Y:%m:%d %H:%M:%S")
        datetime_print = datetime_original.strftime("%Y:%m:%d %H:%M:%S")
        logging.info(f"Found datetime: {datetime_print}")
        logging.info(f"Added capture date and time.")

        # Update GPS information if location is provided
        if location and 'latitude' in location and 'longitude' in location:
            logging.info(f"Found location: {location}")
            gps_ifd = {
                piexif.GPSIFD.GPSLatitudeRef: 'N' if location['latitude'] >= 0 else 'S',
                piexif.GPSIFD.GPSLatitude: _convert_to_degrees(abs(location['latitude'])),
                piexif.GPSIFD.GPSLongitudeRef: 'E' if location['longitude'] >= 0 else 'W',
                piexif.GPSIFD.GPSLongitude: _convert_to_degrees(abs(location['longitude'])),
            }
            exif_dict['GPS'] = gps_ifd
            logging.info(f"Added GPS location: {gps_ifd}")

        # Transfer caption as title in ImageDescription
        if caption:
            logging.info(f"Found caption: {caption}")
            #exif_dict[piexif.ImageIFD.ImageDescription] = caption.encode('utf-8')
            exif_dict['0th'][piexif.ImageIFD.ImageDescription] = caption.encode('utf-8')
            logging.info(f"Updated title with caption.")

        
        exif_bytes = piexif.dump(exif_dict)
        piexif.insert(exif_bytes, image_path.as_posix())
        logging.info(f"Updated EXIF data for {image_path}.")

        # For debugging: Load and log the updated EXIF data
        #updated_exif_dict = piexif.load(image_path.as_posix())
        #logging.info(f"Updated EXIF data for {image_path}: {updated_exif_dict}")
        
    except Exception as e:
        logging.error(f"Failed to update EXIF data for {image_path}: {e}")

# Function to update IPTC information
def update_iptc(image_path, caption):
    try:
        # Load the IPTC data from the image
        info = IPTCInfo(image_path, force=True)  # Use force=True to create IPTC data if it doesn't exist
        
        # Check for errors (known issue with iptcinfo3 creating _markers attribute error)
        if not hasattr(info, '_markers'):
            info._markers = []
        
        # Update the "Caption-Abstract" field
        if caption:
            info['caption/abstract'] = caption
            logging.info(f"Caption added to converted image.")

        # Add static IPTC tags and keywords
        info['source'] = source_app
        info['originating program'] = processing_tool

        # Save the changes back to the image
        info.save_as(image_path)
        logging.info(f"Updated IPTC Caption-Abstract for {image_path}")
    except Exception as e:
        logging.error(f"Failed to update IPTC Caption-Abstract for {image_path}: {e}")


# Function to handle deduplication
def get_unique_filename(path):
    if not path.exists():
        return path
    else:
        prefix = path.stem
        suffix = path.suffix
        counter = 1
        while path.exists():
            path = path.with_name(f"{prefix}_{counter}{suffix}")
            counter += 1
        return path

def combine_images_with_resizing(primary_path, secondary_path):
    # Parameters for rounded corners, outline and position
    corner_radius = 60
    outline_size = 7
    position = (55, 55)

    # Load primary and secondary images
    primary_image = Image.open(primary_path)
    secondary_image = Image.open(secondary_path)

    # Resize the secondary image using LANCZOS resampling for better quality
    scaling_factor = 1/3.33333333  
    width, height = secondary_image.size
    new_width = int(width * scaling_factor)
    new_height = int(height * scaling_factor)
    resized_secondary_image = secondary_image.resize((new_width, new_height), Image.Resampling.LANCZOS)

    # Ensure secondary image has an alpha channel for transparency
    if resized_secondary_image.mode != 'RGBA':
        resized_secondary_image = resized_secondary_image.convert('RGBA')

    # Create mask for rounded corners
    mask = Image.new('L', (new_width, new_height), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, new_width, new_height), corner_radius, fill=255)

    # Apply the rounded corners mask to the secondary image
    resized_secondary_image.putalpha(mask)

    # Create a new blank image with the size of the primary image
    combined_image = Image.new("RGB", primary_image.size)
    combined_image.paste(primary_image, (0, 0))    

    # Draw the black outline with rounded corners directly on the combined image
    outline_layer = Image.new('RGBA', combined_image.size, (0, 0, 0, 0))  # Transparent layer for drawing the outline
    draw = ImageDraw.Draw(outline_layer)
    outline_box = [position[0] - outline_size, position[1] - outline_size, position[0] + new_width + outline_size, position[1] + new_height + outline_size]
    draw.rounded_rectangle(outline_box, corner_radius + outline_size, fill=(0, 0, 0, 255))

    # Merge the outline layer with the combined image
    combined_image.paste(outline_layer, (0, 0), outline_layer)

    # Paste the secondary image onto the combined image using its alpha channel as the mask
    combined_image.paste(resized_secondary_image, position, resized_secondary_image)

    return combined_image

# Function to clean up backup files left behind by iptcinfo3
def remove_backup_files(directory):
    if not os.path.exists(directory):
        return
    # List all files in the given directory
    for filename in os.listdir(directory):
        # Check if the filename ends with '~'
        if filename.endswith('~'):
            # Construct the full path to the file
            file_path = os.path.join(directory, filename)
            try:
                # Remove the file
                os.remove(file_path)
                logging.info(f"Removed backup file: {file_path}")
            except Exception as e:
                logging.error(f"Failed to remove backup file {file_path}: {e}")

def remove_webp_files(directory):
    if not os.path.exists(directory):
        return
    for filename in os.listdir(directory):
        if filename.lower().endswith('.webp'):
            file_path = os.path.join(directory, filename)
            try:
                os.remove(file_path)
                logging.info(f"Removed WebP file: {file_path}")
            except Exception as e:
                logging.error(f"Failed to remove WebP file {file_path}: {e}")

def delete_processed_files(processed_paths):
    for path in set(processed_paths):
        try:
            if path.exists():
                path.unlink()
                logging.info(f"Deleted processed file: {path}")
        except Exception as e:
            logging.error(f"Failed to delete processed file {path}: {e}")

def remove_empty_directory(directory):
    try:
        if directory.exists() and directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
            logging.info(f"Removed empty directory: {directory}")
    except Exception as e:
        logging.error(f"Failed to remove empty directory {directory}: {e}")

def move_directory_to_script_dir(src_directory):
    try:
        if not src_directory.exists():
            return
        if src_directory.resolve().parent == script_dir:
            return
        destination = script_dir / src_directory.name
        if destination.exists():
            counter = 1
            while True:
                candidate = script_dir / f"{src_directory.name}_{counter}"
                if not candidate.exists():
                    destination = candidate
                    break
                counter += 1
        shutil.move(str(src_directory), str(destination))
        logging.info(f"Moved folder to: {destination}")
    except Exception as e:
        logging.error(f"Failed to move folder {src_directory}: {e}")

# Load the JSON file
try:
    with open(base_dir / 'posts.json', encoding="utf8") as f:
        data = json.load(f)
except FileNotFoundError:
    logging.error("JSON file not found. Please check the path.")
    exit()

filtered_entries = []
for entry in data:
    try:
        taken_at = datetime.strptime(entry['takenAt'], "%Y-%m-%dT%H:%M:%S.%fZ")
        if since_date and taken_at.date() < since_date:
            skipped_entries_by_date_count += 1
            logging.info(f"Skipping entry from {taken_at.date()} before {since_date}.")
            continue
        filtered_entries.append((entry, taken_at))
    except Exception as e:
        logging.error(f"Error reading entry {entry}: {e}")

total_entries = len(filtered_entries)
if use_progress_bars and total_entries == 0:
    output_status("No entries to process.")

# Process files
for entry_index, (entry, taken_at) in enumerate(filtered_entries, start=1):
    try:
        # Extract only the filename from the path and then append it to the photo_folder path
        primary_filename = Path(entry['primary']['path']).name
        secondary_filename = Path(entry['secondary']['path']).name
        
        primary_path = photo_folder / primary_filename
        secondary_path = photo_folder / secondary_filename

        if not os.path.exists(primary_path):
            primary_path = bereal_folder / primary_filename
            secondary_path = bereal_folder / secondary_filename
        location = entry.get('location')  # This will be None if 'location' is not present
        caption = entry.get('caption')  # This will be None if 'caption' is not present

        
        for path, role in [(primary_path, 'primary'), (secondary_path, 'secondary')]:
            logging.info(f"Found image: {path}")
            # Check if conversion to JPEG is enabled by the user
            if convert_to_jpeg == 'yes':
                # Convert WebP to JPEG if necessary
                converted_path, converted = convert_webp_to_jpg(path)
                if converted_path is None:
                    skipped_files_count += 1
                    continue  # Skip this file if conversion failed
                if converted:
                    converted_files_count += 1

            # Adjust filename based on user's choice
            time_str = taken_at.strftime("%Y-%m-%dT%H-%M-%S")  # ISO standard format with '-' instead of ':' for time
            original_filename_without_extension = Path(path).stem  # Extract original filename without extension
            
            if convert_to_jpeg == 'yes':
                if keep_original_filename == 'yes':
                    new_filename = f"{time_str}_{role}_{converted_path.name}"
                else:
                    new_filename = f"{time_str}_{role}.jpg"
            else:
                if keep_original_filename == 'yes':
                    new_filename = f"{time_str}_{role}_{original_filename_without_extension}.webp"
                else:
                    new_filename = f"{time_str}_{role}.webp"
            
            new_path = output_folder / new_filename
            new_path = get_unique_filename(new_path)  # Ensure the filename is unique
            
            if convert_to_jpeg == 'yes' and converted:
                converted_path.rename(new_path)  # Move and rename the file

                # Update EXIF and IPTC data
                update_exif(new_path, taken_at, location, caption)                
                logging.info(f"EXIF data added to converted image.")

                image_path_str = str(new_path)
                update_iptc(image_path_str, caption)
            else:
                shutil.copy2(path, new_path) # Copy to new path
            processed_output_paths.append(new_path)

            if role == 'primary':
                primary_images.append({
                    'path': new_path,
                    'taken_at': taken_at,
                    'location': location,
                    'caption': caption
                })
            else:
                secondary_images.append(new_path)

            logging.info(f"Sucessfully processed {role} image.")
            processed_files_count += 1
            if use_verbose_logging == 'yes':
                print("")
    except Exception as e:
        logging.error(f"Error processing entry {entry}: {e}")
    finally:
        if use_progress_bars and total_entries > 0:
            render_progress(entry_index, total_entries, "Processing entries")

# Create combined images if user chose 'yes'
if create_combined_images == 'yes':
    #Create output folder if it doesn't exist
    output_folder_combined.mkdir(parents=True, exist_ok=True)

    total_combined = len(primary_images)
    if use_progress_bars and total_combined == 0:
        output_status("No combined images to create.")

    for combined_index, (primary_path, secondary_path) in enumerate(zip(primary_images, secondary_images), start=1):
        # Extract metadata from one of the images for consistency
        #taken_at = datetime.strptime(timestamp, "%Y-%m-%dT%H-%M-%S")
        primary_new_path = primary_path['path']
        primary_taken_at = primary_path['taken_at']
        primary_location = primary_path['location']
        primary_caption = primary_path['caption']

        timestamp = primary_new_path.stem.split('_')[0]

        # Construct the new file name for the combined image
        combined_filename = f"{timestamp}_combined.webp"
        combined_image = combine_images_with_resizing(primary_new_path, secondary_path)
        
        combined_image_path = output_folder_combined / (combined_filename)
        combined_image.save(combined_image_path, 'JPEG')
        combined_files_count += 1

        logging.info(f"Combined image saved: {combined_image_path}")

        update_exif(combined_image_path, primary_taken_at, primary_location, primary_caption)
        logging.info(f"Metadata added to combined image.")

        image_path_str = str(combined_image_path)
        update_iptc(image_path_str, primary_caption)

        if convert_to_jpeg == 'yes':
            # Convert WebP to JPEG if necessary
            converted_path, converted = convert_webp_to_jpg(combined_image_path)
            update_exif(converted_path, primary_taken_at, primary_location, primary_caption)
            logging.info(f"Metadata added to converted image.")
            image_path_str = str(converted_path)
            update_iptc(image_path_str, primary_caption)

            if converted_path is None:
                logging.error(f"Failed to convert combined image to JPEG: {combined_image_path}")
        if use_verbose_logging == 'yes':
            print("")
        if use_progress_bars and total_combined > 0:
            render_progress(combined_index, total_combined, "Combining images")

if create_combined_images == 'yes' and delete_processed_files_after_combining == 'yes':
    output_status(STYLING['BOLD'] + "Deleting processed single images" + STYLING["RESET"])
    delete_processed_files(processed_output_paths)
    remove_backup_files(output_folder)
    remove_empty_directory(output_folder)
    if use_verbose_logging == 'yes':
        print("")
elif delete_processed_files_after_combining == 'yes':
    output_status(STYLING['BOLD'] + "Skipping deletion of single images because combined images were not created" + STYLING["RESET"])
    if use_verbose_logging == 'yes':
        print("")

# Clean up backup files
output_status(STYLING['BOLD'] + "Removing backup files left behind by iptcinfo3" + STYLING["RESET"])
remove_backup_files(output_folder)
if create_combined_images == 'yes': remove_backup_files(output_folder_combined)
if use_verbose_logging == 'yes':
    print("")

if convert_to_jpeg == 'yes':
    output_status(STYLING['BOLD'] + "Removing WebP files from output folder" + STYLING["RESET"])
    remove_webp_files(output_folder)
    if create_combined_images == 'yes':
        remove_webp_files(output_folder_combined)
    if use_verbose_logging == 'yes':
        print("")

move_directory_to_script_dir(output_folder)
move_directory_to_script_dir(output_folder_combined)

# Summary
summary_title = "Processing Summary"
summary_label_width = 26
summary_value_width = 8
summary_width = summary_label_width + summary_value_width
summary_dash_count = max(summary_width - len(summary_title) - 2, 0)
summary_dash_left = summary_dash_count // 2
summary_dash_right = summary_dash_count - summary_dash_left
summary_lines = [
    f"{'-' * summary_dash_left} {summary_title} {'-' * summary_dash_right}",
    f"{'Input files':<{summary_label_width}}{number_of_files:>{summary_value_width}}",
    f"{'Total files processed':<{summary_label_width}}{processed_files_count:>{summary_value_width}}",
    f"{'Files converted':<{summary_label_width}}{converted_files_count:>{summary_value_width}}",
    f"{'Files skipped':<{summary_label_width}}{skipped_files_count:>{summary_value_width}}",
    f"{'Entries skipped by date':<{summary_label_width}}{skipped_entries_by_date_count:>{summary_value_width}}",
    f"{'Files combined':<{summary_label_width}}{combined_files_count:>{summary_value_width}}",
]
summary_text = "\n".join(summary_lines)
if use_progress_bars:
    print("")
output_summary(summary_text, use_verbose_logging)
