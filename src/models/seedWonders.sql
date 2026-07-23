-- Seed default wonder posts for user_id = 1
INSERT INTO posts (user_id, caption, image_url, location, category) VALUES
(1, 'Parthenon Floaties', 'assets/images/explore_1.png', 'Athens', 'Waterfalls'),
(1, 'Temple Columns Path', 'assets/images/explore_2.png', 'Athens', 'Waterfalls'),
(1, 'Parthenon Sunset', 'assets/images/explore_3.png', 'Athens', 'Waterfalls'),
(1, 'Caryatids Temple View', 'assets/images/explore_4.png', 'Rome', 'Waterfalls'),
(1, 'Acropolis Purple Path', 'assets/images/explore_5.png', 'Rome', 'Waterfalls'),
(1, 'Acropolis Grid View', 'assets/images/explore_6.png', 'Rome', 'Waterfalls'),
(1, 'Erechtheion Column Details', 'assets/images/explore_7.png', 'Cairo', 'Waterfalls'),
(1, 'Ancient Greek Vase', 'assets/images/explore_8.png', 'Cairo', 'Waterfalls'),
(1, 'Parthenon Temple View', 'assets/images/explore_3.png', 'Giza', 'Rivers'),
(1, 'Temple Forest Way', 'assets/images/explore_2.png', 'Giza', 'Rivers'),
(1, 'Caryatids Columns', 'assets/images/explore_4.png', 'Kyoto', 'Rivers'),
(1, 'Greek Vase Display', 'assets/images/explore_8.png', 'Kyoto', 'Rivers'),
(1, 'Erechtheion Temple Columns', 'assets/images/explore_7.png', 'Santorini', 'Mountains'),
(1, 'Lighthouse Sea View', 'assets/images/explore_1.png', 'Santorini', 'Mountains'),
(1, 'Sunset Temple', 'assets/images/explore_5.png', 'Paris', 'Mountains'),
(1, 'Forest Temple Pathway', 'assets/images/explore_6.png', 'Paris', 'Mountains')
ON CONFLICT DO NOTHING;
